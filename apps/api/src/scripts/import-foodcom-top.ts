// Import the TOP-N most-reviewed Food.com recipes from the Kaggle CSV (irkaal/foodcom-
// recipes-and-reviews). Two passes: (1) stream to find the review-count threshold for the
// Nth most-reviewed recipe; (2) stream again importing rows at/above that threshold, capped
// at N. Dedups on externalId (safe to re-run). Ingredients stay unlinked free-text — recipes
// are browsable with ratings immediately; linking for pantry/pricing is a separate pass.
//
// Usage: pnpm --filter @meals/api exec tsx src/scripts/import-foodcom-top.ts \
//   --file <recipes.csv> [--top 10000] [--batch 500]

import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'csv-parse';
import { prisma } from '@meals/db';
import type { Prisma } from '@meals/db';
import { parseIngredientLine, complexityOf, toBaseQuantity } from '@meals/core';
import { mapFoodComRow } from '@meals/ingestion';
import type { FoodComRow, NormalizedRecipe } from '@meals/ingestion';

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const CSV_OPTS = { columns: true, relax_quotes: true, relax_column_count: true, bom: true } as const;

async function flushBatch(householdId: string, recipes: NormalizedRecipe[]) {
  if (!recipes.length) return 0;
  const ids = recipes.map((r) => r.externalId!).filter(Boolean);
  const existing = await prisma.recipe.findMany({
    where: { householdId, externalId: { in: ids } },
    select: { externalId: true },
  });
  const seen = new Set(existing.map((e) => e.externalId));
  const fresh = recipes.filter((r) => !seen.has(r.externalId!));
  if (!fresh.length) return 0;

  const recipeRows: Prisma.RecipeCreateManyInput[] = [];
  const ingRows: Prisma.RecipeIngredientCreateManyInput[] = [];
  for (const r of fresh) {
    const id = randomUUID();
    recipeRows.push({
      id,
      householdId,
      name: r.name.slice(0, 300),
      servings: r.servings ?? 4,
      instructions: r.instructions,
      sourceUrl: r.sourceUrl,
      sourceName: r.sourceName,
      externalId: r.externalId,
      imageUrl: r.imageUrl,
      prepMinutes: r.prepMinutes,
      cuisine: r.cuisine,
      category: r.category,
      tags: r.tags,
      complexity: complexityOf(r.ingredientLines.length, r.prepMinutes),
      externalRating: r.externalRating,
      externalRatingCount: r.externalRatingCount,
    });
    for (const line of r.ingredientLines) {
      const p = parseIngredientLine(line);
      const quantity = p.quantity ?? 1;
      const unit = p.unit ?? 'EACH';
      ingRows.push({
        recipeId: id,
        freeText: line.slice(0, 500),
        quantity: quantity.toString(),
        unit,
        baseQuantity: toBaseQuantity(quantity, unit).baseQuantity.toString(),
        optional: p.optional,
      });
    }
  }
  await prisma.recipe.createMany({ data: recipeRows, skipDuplicates: true });
  await prisma.recipeIngredient.createMany({ data: ingRows });
  return fresh.length;
}

async function main() {
  const file = arg('--file');
  if (!file) throw new Error('--file <recipes.csv> is required');
  const top = Number(arg('--top') ?? 10000);
  const batch = Number(arg('--batch') ?? 500);
  const household = await prisma.household.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });

  // Pass 1: collect review counts, find the Nth-highest threshold.
  console.log(`Pass 1/2: scanning review counts for the top ${top}…`);
  const counts: number[] = [];
  for await (const row of createReadStream(file).pipe(parse(CSV_OPTS)) as AsyncIterable<FoodComRow>) {
    const m = mapFoodComRow(row);
    if (m) counts.push(m.externalRatingCount ?? 0);
  }
  counts.sort((a, b) => b - a);
  const threshold = counts[Math.min(top, counts.length) - 1] ?? 0;
  console.log(`  ${counts.length} valid recipes; #1 has ${counts[0]} reviews, #${top} has ${threshold}`);

  // Pass 2: import rows at/above the threshold, newest-popular first, capped at N.
  console.log('Pass 2/2: importing…');
  let inserted = 0;
  let pending: NormalizedRecipe[] = [];
  const started = Date.now();
  for await (const row of createReadStream(file).pipe(parse(CSV_OPTS)) as AsyncIterable<FoodComRow>) {
    if (inserted + pending.length >= top) break;
    const m = mapFoodComRow(row);
    if (!m || (m.externalRatingCount ?? 0) < threshold) continue;
    pending.push(m);
    if (pending.length >= batch) {
      inserted += await flushBatch(household.id, pending);
      pending = [];
      const rate = Math.round(inserted / ((Date.now() - started) / 1000));
      process.stdout.write(`\r  imported ${inserted}/${top} (${rate}/s)`);
    }
  }
  inserted += await flushBatch(household.id, pending.slice(0, Math.max(0, top - inserted)));
  console.log(`\nDONE — imported ${inserted} Food.com recipes (>= ${threshold} reviews)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
