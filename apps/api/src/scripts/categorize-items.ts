// One-time (idempotent) canonical-item categorization via a local LLM, so the pantry can
// group by aisle-style categories. Only items with category NULL are touched.
//
// Usage:
//   pnpm --filter @meals/api exec tsx src/scripts/categorize-items.ts \
//     [--llm-base-url http://localhost:11434/v1] [--llm-model qwen2.5:7b] [--limit N]

import * as z from 'zod/v4';
import { prisma } from '@meals/db';
import { chatJson } from '@meals/ingestion';

const CATEGORIES = [
  'Produce',
  'Meat & Seafood',
  'Dairy & Eggs',
  'Bakery & Baking',
  'Grains & Pasta',
  'Canned & Jarred',
  'Spices & Seasoning',
  'Condiments & Sauces',
  'Frozen',
  'Beverages',
  'Snacks',
  'Other',
] as const;

const resultSchema = z.array(
  z.object({ id: z.string(), category: z.enum(CATEGORIES) }),
);

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const baseUrl = arg('--llm-base-url') ?? 'http://localhost:11434/v1';
  const model = arg('--llm-model') ?? 'qwen2.5:7b';
  const limit = Number(arg('--limit') ?? Infinity);
  // --all re-categorizes EVERY item (fixes wrong categories like sugar-in-Beverages), not
  // just the ones missing a category.
  const all = process.argv.includes('--all');

  const items = await prisma.canonicalItem.findMany({
    where: all ? {} : { category: null },
    select: { id: true, name: true },
    take: limit === Infinity ? undefined : limit,
  });
  console.log(`${items.length} item(s) to categorize (${all ? 'all' : 'uncategorized only'}); model ${model} @ ${baseUrl}`);

  const BATCH = 60;
  let done = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    try {
      const raw = await chatJson({
        baseUrl,
        model,
        system:
          `You categorize grocery items into store aisles. Allowed categories (use EXACTLY these strings): ` +
          `${CATEGORIES.join(' | ')}. ` +
          `Respond with JSON {"results": [{"id", "category"}]} echoing each input id.`,
        prompt: JSON.stringify(batch),
        maxTokens: 3000,
      });
      const obj = raw as { results?: unknown };
      const results = resultSchema.parse(Array.isArray(raw) ? raw : obj.results);
      const byCategory = new Map<string, string[]>();
      const validIds = new Set(batch.map((b) => b.id));
      for (const r of results) {
        if (!validIds.has(r.id)) continue;
        const list = byCategory.get(r.category);
        if (list) list.push(r.id);
        else byCategory.set(r.category, [r.id]);
      }
      for (const [category, ids] of byCategory) {
        await prisma.canonicalItem.updateMany({ where: { id: { in: ids } }, data: { category } });
        done += ids.length;
      }
    } catch (err) {
      failed += batch.length;
      console.warn(`batch failed (${err instanceof Error ? err.message : err}) — left NULL`);
    }
    process.stdout.write(`\r${Math.min(i + BATCH, items.length)}/${items.length} (ok=${done} failed=${failed})`);
  }
  console.log(`\nDONE — categorized ${done}, failed ${failed} (re-run to retry failures)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
