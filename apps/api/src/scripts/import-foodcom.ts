// Bulk-import the Food.com Kaggle dataset (irkaal/foodcom-recipes-and-reviews, recipes.csv)
// into the recipe catalog. Streams the CSV (the file is ~700MB — never loaded whole),
// maps rows via @meals/ingestion, parses ingredient lines, and batch-inserts with dedup on
// (householdId, externalId). Ingredients stay unlinked free-text (fuzzy-matching 500K×9 lines
// at import time is not worth it; linking happens lazily as the canonical catalog grows).
//
// Usage:
//   pnpm --filter @meals/api exec tsx src/scripts/import-foodcom.ts \
//     --file /path/to/recipes.csv [--limit N] [--min-reviews N] [--min-rating X] [--batch N]
//
// See docs/foodcom-import.md for downloading the dataset.

import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'csv-parse';
import { prisma } from '@meals/db';
import type { Prisma } from '@meals/db';
import { parseIngredientLine, complexityOf, toBaseQuantity } from '@meals/core';
import { mapFoodComRow } from '@meals/ingestion';
import type { FoodComRow, NormalizedRecipe } from '@meals/ingestion';

interface Args {
  file: string;
  limit: number;
  minReviews: number;
  minRating: number;
  batch: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const file = get('--file');
  if (!file) {
    console.error(
      'Usage: tsx src/scripts/import-foodcom.ts --file recipes.csv [--limit N] [--min-reviews N] [--min-rating X] [--batch N]',
    );
    process.exit(1);
  }
  return {
    file,
    limit: Number(get('--limit') ?? Infinity),
    minReviews: Number(get('--min-reviews') ?? 0),
    minRating: Number(get('--min-rating') ?? 0),
    batch: Number(get('--batch') ?? 500),
  };
}

/** Trigram indexes keep ILIKE search usable at catalog scale. Idempotent. */
async function ensureSearchIndexes() {
  await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS recipe_name_trgm ON "Recipe" USING gin (name gin_trgm_ops)`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS recipe_ing_freetext_trgm ON "RecipeIngredient" USING gin ("freeText" gin_trgm_ops)`,
  );
}

async function flushBatch(
  householdId: string,
  recipes: NormalizedRecipe[],
): Promise<{ inserted: number; skipped: number }> {
  if (!recipes.length) return { inserted: 0, skipped: 0 };

  // Dedup against what's already in the DB (unique on householdId+externalId).
  const ids = recipes.map((r) => r.externalId!).filter(Boolean);
  const existing = await prisma.recipe.findMany({
    where: { householdId, externalId: { in: ids } },
    select: { externalId: true },
  });
  const seen = new Set(existing.map((e) => e.externalId));
  const fresh = recipes.filter((r) => !seen.has(r.externalId!));
  if (!fresh.length) return { inserted: 0, skipped: recipes.length };

  const recipeRows: Prisma.RecipeCreateManyInput[] = [];
  const ingredientRows: Prisma.RecipeIngredientCreateManyInput[] = [];

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
      ingredientRows.push({
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
  await prisma.recipeIngredient.createMany({ data: ingredientRows });
  return { inserted: fresh.length, skipped: recipes.length - fresh.length };
}

async function main() {
  const args = parseArgs();
  const household = await prisma.household.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  console.log(`Importing into household ${household.id} from ${args.file}`);
  console.log(
    `filters: min-reviews=${args.minReviews} min-rating=${args.minRating} limit=${args.limit}`,
  );

  await ensureSearchIndexes();

  const parser = createReadStream(args.file).pipe(
    parse({ columns: true, relax_quotes: true, relax_column_count: true, bom: true }),
  );

  let scanned = 0;
  let inserted = 0;
  let skipped = 0;
  let filtered = 0;
  let pending: NormalizedRecipe[] = [];
  const started = Date.now();

  for await (const row of parser as AsyncIterable<FoodComRow>) {
    scanned++;
    if (inserted + pending.length >= args.limit) break;

    const mapped = mapFoodComRow(row);
    if (!mapped) {
      filtered++;
      continue;
    }
    if ((mapped.externalRatingCount ?? 0) < args.minReviews) {
      filtered++;
      continue;
    }
    if ((mapped.externalRating ?? 0) < args.minRating) {
      filtered++;
      continue;
    }

    pending.push(mapped);
    if (pending.length >= args.batch) {
      const res = await flushBatch(household.id, pending);
      inserted += res.inserted;
      skipped += res.skipped;
      pending = [];
      if (inserted % 10000 < args.batch) {
        const rate = Math.round(inserted / ((Date.now() - started) / 1000));
        console.log(`scanned=${scanned} inserted=${inserted} skipped=${skipped} filtered=${filtered} (${rate}/s)`);
      }
    }
  }
  const res = await flushBatch(household.id, pending);
  inserted += res.inserted;
  skipped += res.skipped;

  const secs = Math.round((Date.now() - started) / 1000);
  console.log(
    `DONE in ${secs}s — scanned=${scanned} inserted=${inserted} already-present=${skipped} filtered-out=${filtered}`,
  );
  console.log(`catalog size: ${await prisma.recipe.count({ where: { householdId: household.id } })}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
