// LLM linking pass for the long tail: map each still-unlinked recipe-ingredient line to a
// buyable root ingredient with qwen2.5:7b, link it, and create a canonical item (with category)
// when none exists. Deduped by parsed name so the model runs once per distinct ingredient and
// the catalog gains far fewer rows. Safe: never deletes; sanity-gates roots; records aliases.
//
// Usage: pnpm --filter @meals/api exec tsx src/scripts/link-tail.ts [--dry] [--llm-model qwen2.5:7b]

import { prisma } from '@meals/db';
import { parseIngredientLine, buildNormKey } from '@meals/core';
import { canonicalizeNames } from '../lib/canonicalize.js';

const dry = process.argv.includes('--dry');
const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const normAlias = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

// Reject roots that aren't a plausible buyable ingredient.
function saneRoot(root: string): boolean {
  const r = root.trim();
  return (
    r.length >= 2 &&
    r.length <= 40 &&
    /[a-z]/i.test(r) &&
    !/[:;]/.test(r) &&
    !/^(accompaniment|serving|garnish|for |such as|optional|to serve)/i.test(r)
  );
}

async function main() {
  const model = arg('--llm-model') ?? 'qwen2.5:7b';
  const baseUrl = arg('--llm-base-url') ?? 'http://localhost:11434/v1';

  const rows = await prisma.recipeIngredient.findMany({
    where: { canonicalItemId: null, freeText: { not: null } },
    select: { id: true, freeText: true, recipe: { select: { householdId: true } } },
  });
  const householdId = rows.find((r) => r.recipe?.householdId)?.recipe!.householdId;
  if (!householdId) return console.log('Nothing to link.');

  // Dedupe by parsed name: one LLM decision per distinct ingredient, applied to all its rows.
  const byName = new Map<string, { name: string; rowIds: string[] }>();
  for (const r of rows) {
    const name = parseIngredientLine(r.freeText!).name;
    const key = normAlias(name);
    if (!key) continue;
    const e = byName.get(key) ?? { name, rowIds: [] };
    e.rowIds.push(r.id);
    byName.set(key, e);
  }
  const uniques = [...byName.values()].map((v, i) => ({ id: String(i), name: v.name, rowIds: v.rowIds }));
  console.log(`${rows.length} unlinked rows -> ${uniques.length} distinct names; model ${model}`);

  const map = await canonicalizeNames(
    uniques.map((u) => ({ id: u.id, name: u.name })),
    { baseUrl, model },
  );

  const existing = await prisma.canonicalItem.findMany({ select: { id: true, name: true } });
  const byExact = new Map(existing.map((e) => [e.name.toLowerCase(), e.id]));
  const aliasRows = await prisma.ingredientAlias.findMany({ select: { rawName: true, canonicalItemId: true } });
  const aliasMap = new Map(aliasRows.map((a) => [a.rawName, a.canonicalItemId]));

  let linked = 0;
  let created = 0;
  let skipped = 0;
  for (const u of uniques) {
    const m = map.get(u.id);
    if (!m || !saneRoot(m.root)) {
      skipped++;
      continue;
    }
    const rootKey = normAlias(m.root);
    let itemId = aliasMap.get(rootKey) ?? byExact.get(m.root.toLowerCase());

    if (dry) {
      linked += u.rowIds.length;
      if (!itemId) created++;
      continue;
    }

    if (!itemId) {
      const item = await prisma.canonicalItem.create({
        data: { name: m.root, category: m.category, normKey: buildNormKey(m.root) },
      });
      itemId = item.id;
      byExact.set(m.root.toLowerCase(), itemId);
      created++;
    }
    await prisma.recipeIngredient.updateMany({ where: { id: { in: u.rowIds } }, data: { canonicalItemId: itemId } });
    linked += u.rowIds.length;
    for (const rn of new Set([normAlias(u.name), rootKey])) {
      if (aliasMap.has(rn)) continue;
      aliasMap.set(rn, itemId);
      await prisma.ingredientAlias.upsert({
        where: { rawName: rn },
        create: { rawName: rn, canonicalItemId: itemId },
        update: {},
      });
    }
  }

  console.log(
    `${dry ? 'DRY: ' : ''}linked ${linked} rows, created ${created} new item(s), skipped ${skipped} name(s)`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
