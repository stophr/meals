// Retroactively link the unlinked RecipeIngredient rows (free-text only) to canonical items,
// applying the alias index + deterministic root + fuzzy match — the same resolution new
// imports now use. In place: no recipe re-import, parsing/quantities are left untouched.
//
// Usage: pnpm --filter @meals/api exec tsx src/scripts/relink-ingredients.ts [--dry]

import { prisma } from '@meals/db';
import { parseIngredientLine, matchLine, rootIngredientName, ingredientKey } from '@meals/core';

const dry = process.argv.includes('--dry');
const normAlias = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

async function main() {
  const rows = await prisma.recipeIngredient.findMany({
    where: { canonicalItemId: null },
    select: { id: true, freeText: true, recipe: { select: { householdId: true } } },
  });
  const householdId = rows.find((r) => r.recipe?.householdId)?.recipe!.householdId;
  if (!householdId) {
    console.log('No unlinked ingredients.');
    return;
  }

  const items = await prisma.canonicalItem.findMany({
    where: { householdId },
    select: { id: true, name: true, brand: true },
  });
  const byName = new Map(items.map((i) => [i.name.toLowerCase(), i.id]));
  const candidates = items.map((i) => ({ productId: i.id, text: `${i.brand ?? ''} ${i.name}`.trim() }));
  const aliasRows = await prisma.ingredientAlias.findMany({
    where: { householdId },
    select: { rawName: true, canonicalItemId: true },
  });
  const aliasMap = new Map(aliasRows.map((a) => [a.rawName, a.canonicalItemId]));

  const tally = { alias: 0, root: 0, fuzzy: 0, unresolved: 0 };
  const updates: { id: string; canonicalItemId: string }[] = [];
  const newAliases: { rawName: string; canonicalItemId: string }[] = [];

  for (const r of rows) {
    if (!r.freeText) {
      tally.unresolved++;
      continue;
    }
    const name = parseIngredientLine(r.freeText).name;
    const key = normAlias(name);
    const rootKey = ingredientKey(name);

    let hit = aliasMap.get(key) ?? aliasMap.get(rootKey);
    let via: keyof typeof tally = 'alias';
    if (!hit) {
      const byRoot = byName.get(rootIngredientName(name).toLowerCase());
      if (byRoot) {
        hit = byRoot;
        via = 'root';
      }
    }
    if (!hit) {
      const m = candidates.length ? matchLine(name, candidates) : null;
      if (m?.decision === 'auto') {
        hit = m.productId ?? undefined;
        via = 'fuzzy';
      }
    }
    if (!hit) {
      tally.unresolved++;
      continue;
    }
    tally[via]++;
    updates.push({ id: r.id, canonicalItemId: hit });
    if (!aliasMap.has(key)) newAliases.push({ rawName: key, canonicalItemId: hit });
  }

  console.log(
    `Unlinked rows: ${rows.length}\n` +
      `  linkable via alias: ${tally.alias}\n` +
      `  linkable via root:  ${tally.root}\n` +
      `  linkable via fuzzy: ${tally.fuzzy}\n` +
      `  still unresolved:   ${tally.unresolved}`,
  );

  if (dry) {
    console.log('\n(dry run — no writes)');
    return;
  }

  for (let i = 0; i < updates.length; i += 500) {
    await prisma.$transaction(
      updates.slice(i, i + 500).map((u) =>
        prisma.recipeIngredient.update({ where: { id: u.id }, data: { canonicalItemId: u.canonicalItemId } }),
      ),
    );
  }
  // Record fresh aliases (dedup) so future imports resolve these names too.
  const seen = new Set<string>();
  for (const a of newAliases) {
    if (seen.has(a.rawName)) continue;
    seen.add(a.rawName);
    await prisma.ingredientAlias.upsert({
      where: { householdId_rawName: { householdId, rawName: a.rawName } },
      create: { householdId, rawName: a.rawName, canonicalItemId: a.canonicalItemId },
      update: {},
    });
  }
  console.log(`\nLinked ${updates.length} rows; recorded ${seen.size} new alias(es).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
