// Re-parse Food.com recipes from the LOCAL raw cache (RecipeRawFetch) — no network. Run this
// whenever a parser/enrichment fix lands to re-apply it across the corpus in seconds instead of
// re-crawling for hours. Idempotent: enrichRecipe only rewrites recipes the re-parse improves.
//
// Usage: pnpm --filter @meals/api exec tsx src/scripts/reparse-foodcom.ts [--limit N]

import { prisma } from '@meals/db';
import { parseRecipeNode } from '@meals/ingestion';
import { loadLinkContext, enrichRecipe } from '../lib/recipeIngest.js';

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const limit = Number(arg('--limit') ?? Infinity);
  const household = await prisma.household.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const ctx = await loadLinkContext(household.id);

  const raws = await prisma.recipeRawFetch.findMany({
    take: limit === Infinity ? undefined : limit,
  });
  console.log(`Re-parsing ${raws.length} cached raw fetches (local, no network)…`);

  // Map externalId -> recipe (with the fields enrichRecipe needs).
  const recipes = await prisma.recipe.findMany({
    where: { householdId: household.id, externalId: { in: raws.map((r) => r.externalId) } },
    select: { id: true, externalId: true, servings: true, instructions: true, imageUrl: true, prepMinutes: true, cuisine: true, category: true },
  });
  const byExt = new Map(recipes.map((r) => [r.externalId!, r]));

  let enriched = 0;
  let unchanged = 0;
  let missing = 0;
  let failed = 0;
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i]!;
    const recipe = byExt.get(raw.externalId);
    if (!recipe) {
      missing++;
      continue;
    }
    try {
      const normalized = parseRecipeNode(raw.raw, raw.sourceUrl);
      const { enriched: did } = await enrichRecipe(recipe, normalized, ctx);
      did ? enriched++ : unchanged++;
    } catch {
      failed++;
    }
    if ((i + 1) % 500 === 0 || i + 1 === raws.length) {
      process.stdout.write(`\r  ${i + 1}/${raws.length} — enriched ${enriched}, unchanged ${unchanged}, missing ${missing}, failed ${failed}`);
    }
  }
  console.log(`\nDONE — re-parsed ${raws.length}: enriched ${enriched}, unchanged ${unchanged}, missing ${missing}, failed ${failed}. Run recompute-costs after.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
