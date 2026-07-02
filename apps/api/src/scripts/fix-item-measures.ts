// One-time (idempotent) canonical-item cleanup:
//   1. Dedupe items that share a name (e.g. 5x "Milk") into one, repointing all references.
//   2. Set each item's baseUnit/baseDimension from how RECIPES actually measure it, so the
//      pantry defaults to weight/volume instead of a meaningless count ("Olive Oil" is TBSP,
//      "Sugar" is CUP, "Salt" is TSP — not EACH).
//   3. Flag always-on-hand staples (water, ice) as assumeStocked so they never show as
//      "missing" and are skipped when building shopping lists.
//
// Usage:
//   pnpm --filter @meals/api exec tsx src/scripts/fix-item-measures.ts [--dry]

import { prisma } from '@meals/db';
import { dimensionOf } from '@meals/core';
import { BASE_UNIT, type Unit, type UnitDimension } from '@meals/shared';

const ALWAYS_STOCKED = new Set([
  'water',
  'tap water',
  'cold water',
  'warm water',
  'hot water',
  'boiling water',
  'ice water',
  'ice',
  'ice cubes',
  'crushed ice',
]);

const dry = process.argv.includes('--dry');
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

async function main() {
  // ---- 1. Dedupe by normalized name ----
  const items = await prisma.canonicalItem.findMany({
    select: { id: true, name: true, createdAt: true },
  });
  const useCounts = await prisma.recipeIngredient.groupBy({
    by: ['canonicalItemId'],
    where: { canonicalItemId: { not: null } },
    _count: true,
  });
  const usesById = new Map(useCounts.map((u) => [u.canonicalItemId as string, u._count]));

  const byName = new Map<string, typeof items>();
  for (const it of items) {
    const key = norm(it.name);
    const list = byName.get(key);
    if (list) list.push(it);
    else byName.set(key, [it]);
  }

  let merged = 0;
  for (const [, group] of byName) {
    if (group.length < 2) continue;
    // Survivor = most recipe uses, then oldest.
    group.sort(
      (a, b) =>
        (usesById.get(b.id) ?? 0) - (usesById.get(a.id) ?? 0) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const [survivor, ...dupes] = group;
    if (!survivor) continue;
    for (const d of dupes) {
      if (dry) {
        merged++;
        continue;
      }
      await prisma.$transaction(async (tx) => {
        await tx.providerProduct.updateMany({ where: { canonicalItemId: d.id }, data: { canonicalItemId: survivor.id } });
        await tx.recipeIngredient.updateMany({ where: { canonicalItemId: d.id }, data: { canonicalItemId: survivor.id } });
        await tx.inventoryLot.updateMany({ where: { canonicalItemId: d.id }, data: { canonicalItemId: survivor.id } });
        await tx.shoppingListItem.updateMany({ where: { canonicalItemId: d.id }, data: { canonicalItemId: survivor.id } });
        await tx.canonicalItem.delete({ where: { id: d.id } });
      });
      merged++;
    }
  }
  console.log(`Deduped: merged ${merged} duplicate item(s)`);

  // ---- 2. Set measurement type from dominant recipe usage ----
  const survivors = await prisma.canonicalItem.findMany({ select: { id: true, name: true, baseUnit: true } });
  const unitRows = await prisma.recipeIngredient.groupBy({
    by: ['canonicalItemId', 'unit'],
    where: { canonicalItemId: { not: null } },
    _count: true,
  });
  // canonicalItemId -> dimension -> use count
  const dimUses = new Map<string, Map<UnitDimension, number>>();
  for (const r of unitRows) {
    const id = r.canonicalItemId as string;
    const dim: UnitDimension = r.unit ? dimensionOf(r.unit as Unit) : 'COUNT';
    let m = dimUses.get(id);
    if (!m) {
      m = new Map();
      dimUses.set(id, m);
    }
    m.set(dim, (m.get(dim) ?? 0) + r._count);
  }

  let reunit = 0;
  let stocked = 0;
  for (const it of survivors) {
    const data: { baseUnit?: Unit; baseDimension?: UnitDimension; assumeStocked?: boolean } = {};

    const m = dimUses.get(it.id);
    if (m && m.size) {
      const [dominant] = [...m.entries()].sort((a, b) => b[1] - a[1]);
      if (dominant) {
        const dim = dominant[0];
        const baseUnit = BASE_UNIT[dim];
        if (baseUnit !== it.baseUnit) {
          data.baseUnit = baseUnit;
          data.baseDimension = dim;
        }
      }
    }
    if (ALWAYS_STOCKED.has(norm(it.name))) data.assumeStocked = true;

    if (!Object.keys(data).length) continue;
    if (data.baseUnit) reunit++;
    if (data.assumeStocked) stocked++;
    if (!dry) await prisma.canonicalItem.update({ where: { id: it.id }, data });
  }
  console.log(`Re-measured ${reunit} item(s); flagged ${stocked} always-stocked staple(s)`);
  if (dry) console.log('(dry run — no writes)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
