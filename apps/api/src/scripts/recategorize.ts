// Re-assign the aisle category for every canonical item using the canonicalizer's category
// prompt (which handles the traps well — sugars -> Bakery & Baking, not Beverages). Uses the
// same local text model as consolidation. Resilient: a bad batch skips those rows, it never
// nulls a good category.
//
// Usage: pnpm --filter @meals/api exec tsx src/scripts/recategorize.ts \
//   [--llm-model qwen2.5:7b] [--llm-base-url http://localhost:11434/v1] [--only-wrong]

import { prisma } from '@meals/db';
import { canonicalizeNames } from '../lib/canonicalize.js';

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const model = arg('--llm-model') ?? 'qwen2.5:7b';
  const baseUrl = arg('--llm-base-url') ?? 'http://localhost:11434/v1';

  const items = await prisma.canonicalItem.findMany({ select: { id: true, name: true } });
  console.log(`Recategorizing ${items.length} item(s) with ${model}…`);

  const BATCH = 30;
  let updated = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    try {
      const map = await canonicalizeNames(slice, { baseUrl, model, batch: BATCH });
      for (const it of slice) {
        const m = map.get(it.id);
        if (m?.category) {
          await prisma.canonicalItem.update({ where: { id: it.id }, data: { category: m.category } });
          updated++;
        }
      }
    } catch (e) {
      console.warn(`  batch @${i} failed: ${e instanceof Error ? e.message : e}`);
    }
    process.stdout.write(`\r  ${Math.min(i + BATCH, items.length)}/${items.length} (updated ${updated})`);
  }
  console.log(`\nDONE — updated ${updated} categories`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
