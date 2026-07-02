// Build the ~1000-recipe development catalog with REAL measurements, replacing the
// unit-less Food.com bulk import:
//   - TheMealDB full dump (~300 recipes; strong cuisine/category spread, images, measures)
//   - Epicurious stratified sample (default 700; "1 cup chopped onion" lines + 0-5 ratings),
//     spread evenly across cuisine/course buckets
//
// Usage:
//   pnpm --filter @meals/api exec tsx src/scripts/import-dev-catalog.ts \
//     [--purge-foodcom] [--epi-file /path/to/full_format_recipes.json] [--epi-target 700]
//
// Epicurious dataset: kagglehub.dataset_download('hugodarwood/epirecipes')

import { readFileSync } from 'node:fs';
import { prisma } from '@meals/db';
import {
  listAreas,
  listMealIdsByArea,
  getMeal,
  mapEpicuriousRecipe,
} from '@meals/ingestion';
import type { EpiRecipe, NormalizedRecipe } from '@meals/ingestion';
import { ingestRecipe } from '../lib/recipeIngest.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function purgeFoodCom() {
  console.log('Purging Food.com bulk import…');
  const t = Date.now();
  // Delete ingredients first: much faster than relying on per-row FK cascades.
  await prisma.$executeRaw`
    DELETE FROM "RecipeIngredient" ri USING "Recipe" r
    WHERE ri."recipeId" = r.id AND r."sourceName" = 'Food.com'`;
  await prisma.$executeRaw`
    DELETE FROM "MealPlanEntry" e USING "Recipe" r
    WHERE e."recipeId" = r.id AND r."sourceName" = 'Food.com'`;
  const purged = await prisma.recipe.deleteMany({ where: { sourceName: 'Food.com' } });
  await prisma.$executeRawUnsafe(`ANALYZE "Recipe"`);
  await prisma.$executeRawUnsafe(`ANALYZE "RecipeIngredient"`);
  console.log(`purged ${purged.count} Food.com recipes in ${Math.round((Date.now() - t) / 1000)}s`);
}

async function importTheMealDb(householdId: string): Promise<number> {
  console.log('Importing TheMealDB full dump…');
  const areas = await listAreas();
  let imported = 0;
  for (const area of areas) {
    const ids = await listMealIdsByArea(area);
    for (const id of ids) {
      try {
        const normalized = await getMeal(id);
        const { duplicate } = await ingestRecipe(normalized, householdId);
        if (!duplicate) imported++;
      } catch (err) {
        console.warn(`  meal ${id} failed: ${err instanceof Error ? err.message : err}`);
      }
      await sleep(80); // be polite to the free API
    }
    process.stdout.write(`\r  ${area}: total imported ${imported}`);
  }
  console.log(`\nTheMealDB: ${imported} recipes`);
  return imported;
}

async function importEpicurious(
  householdId: string,
  file: string,
  target: number,
): Promise<number> {
  console.log(`Importing Epicurious sample (target ${target}) from ${file}…`);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as EpiRecipe[];

  // Normalize, quality-filter, and bucket by cuisine|course for a stratified sample.
  const buckets = new Map<string, NormalizedRecipe[]>();
  for (const r of raw) {
    const n = mapEpicuriousRecipe(r);
    if (!n) continue;
    if (!n.instructions || n.ingredientLines.length < 3 || n.ingredientLines.length > 25) continue;
    if ((n.externalRating ?? 0) < 3.5) continue;
    const key = `${n.cuisine ?? 'other'}|${n.category ?? 'other'}`;
    const list = buckets.get(key);
    if (list) list.push(n);
    else buckets.set(key, [n]);
  }
  for (const list of buckets.values()) list.sort(() => Math.random() - 0.5);
  console.log(`  ${raw.length} rows -> ${buckets.size} cuisine|course buckets after filtering`);

  // Round-robin across buckets so every cuisine/course gets representation.
  const picked: NormalizedRecipe[] = [];
  const lists = [...buckets.values()];
  for (let round = 0; picked.length < target; round++) {
    let took = 0;
    for (const list of lists) {
      if (picked.length >= target) break;
      const item = list[round];
      if (item) {
        picked.push(item);
        took++;
      }
    }
    if (took === 0) break; // buckets exhausted
  }

  let imported = 0;
  for (const n of picked) {
    const { duplicate } = await ingestRecipe(n, householdId);
    if (!duplicate) imported++;
    if (imported % 50 === 0) process.stdout.write(`\r  imported ${imported}`);
  }
  console.log(`\nEpicurious: ${imported} recipes`);
  return imported;
}

async function main() {
  const household = await prisma.household.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });

  if (process.argv.includes('--purge-foodcom')) await purgeFoodCom();

  await importTheMealDb(household.id);

  const epiFile = arg('--epi-file');
  if (epiFile) {
    await importEpicurious(household.id, epiFile, Number(arg('--epi-target') ?? 700));
  } else {
    console.log('(no --epi-file given — skipping Epicurious; catalog will be TheMealDB only)');
  }

  const total = await prisma.recipe.count({ where: { householdId: household.id } });
  console.log(`catalog size: ${total}`);
  console.log('Next: link ingredients ->');
  console.log('  pnpm --filter @meals/api exec tsx src/scripts/link-ingredients.ts --llm --create-threshold 2');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
