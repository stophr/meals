// Consolidate the canonical-ingredient corpus WITHOUT breaking recipes:
//   1. Group items by their deterministic root name (rootIngredientName): "Pinch Of Sugar",
//      "Tblsp Caster Sugar", "Sugar" all collapse to "Sugar"; "Sugar Snap Peas" does not.
//   2. Pick a survivor per group, repoint every recipe/inventory/product/list reference to it,
//      delete the duplicates.
//   3. Record an IngredientAlias for every original name -> survivor, so future imports and
//      pantry adds resolve to the root instead of spawning new variants.
//
// Safe + idempotent: re-running only finds newly-introduced variants. Root mapping is purely
// deterministic (no LLM) so it never invents a bad merge. Categories are fixed separately.
//
// Usage: pnpm --filter @meals/api exec tsx src/scripts/consolidate-ingredients.ts [--dry]

import { prisma } from '@meals/db';
import { rootIngredientName, ingredientKey, buildNormKey } from '@meals/core';

const dry = process.argv.includes('--dry');
const normAlias = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

async function main() {
  const items = await prisma.canonicalItem.findMany({
    select: { id: true, name: true, householdId: true, createdAt: true, category: true },
  });
  const useRows = await prisma.recipeIngredient.groupBy({
    by: ['canonicalItemId'],
    where: { canonicalItemId: { not: null } },
    _count: true,
  });
  const uses = new Map(useRows.map((u) => [u.canonicalItemId as string, u._count]));

  // Group by deterministic root key.
  const groups = new Map<string, typeof items>();
  for (const it of items) {
    const key = ingredientKey(it.name);
    const list = groups.get(key);
    if (list) list.push(it);
    else groups.set(key, [it]);
  }

  let merged = 0;
  let renamed = 0;
  let aliases = 0;
  let groupsChanged = 0;

  for (const [, group] of groups) {
    const root = rootIngredientName(group[0]!.name);
    // Survivor: prefer one already named the root, then most recipe uses, then oldest.
    group.sort((a, b) => {
      const an = a.name.toLowerCase() === root.toLowerCase() ? 1 : 0;
      const bn = b.name.toLowerCase() === root.toLowerCase() ? 1 : 0;
      return bn - an || (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0) || a.createdAt.getTime() - b.createdAt.getTime();
    });
    const survivor = group[0]!;
    const dupes = group.slice(1);
    if (dupes.length) groupsChanged++;

    if (dry) {
      if (dupes.length || survivor.name !== root) {
        console.log(`  ${root}  <=  ${group.map((g) => `"${g.name}"`).join(', ')}`);
      }
      merged += dupes.length;
      continue;
    }

    await prisma.$transaction(async (tx) => {
      // Rename survivor to the clean root.
      if (survivor.name !== root) {
        await tx.canonicalItem.update({
          where: { id: survivor.id },
          data: { name: root, normKey: buildNormKey(root) },
        });
        renamed++;
      }
      // Fold every duplicate into the survivor.
      for (const d of dupes) {
        await tx.providerProduct.updateMany({ where: { canonicalItemId: d.id }, data: { canonicalItemId: survivor.id } });
        await tx.recipeIngredient.updateMany({ where: { canonicalItemId: d.id }, data: { canonicalItemId: survivor.id } });
        await tx.inventoryLot.updateMany({ where: { canonicalItemId: d.id }, data: { canonicalItemId: survivor.id } });
        await tx.shoppingListItem.updateMany({ where: { canonicalItemId: d.id }, data: { canonicalItemId: survivor.id } });
        await tx.ingredientAlias.updateMany({ where: { canonicalItemId: d.id }, data: { canonicalItemId: survivor.id } });
        await tx.canonicalItem.delete({ where: { id: d.id } });
        merged++;
      }
      // Alias every original name (survivor + dupes) -> survivor, for future resolution.
      for (const member of group) {
        const rawName = normAlias(member.name);
        await tx.ingredientAlias.upsert({
          where: { householdId_rawName: { householdId: survivor.householdId, rawName } },
          create: { householdId: survivor.householdId, rawName, canonicalItemId: survivor.id },
          update: { canonicalItemId: survivor.id },
        });
        aliases++;
      }
    });
  }

  console.log(
    dry
      ? `\nDRY: ${groupsChanged} group(s) would consolidate, folding ${merged} duplicate(s)`
      : `Consolidated ${groupsChanged} group(s): merged ${merged} duplicate(s), renamed ${renamed}, ${aliases} alias(es) recorded`,
  );
  const remaining = await prisma.canonicalItem.count();
  console.log(`Canonical items now: ${remaining}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
