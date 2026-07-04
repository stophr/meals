// Raw crawler: fetch each Food.com recipe page ONCE, store its raw schema.org JSON-LD node in
// RecipeRawFetch, and enrich the recipe from it. Fetching is the slow, rate-limited part —
// storing the raw means any future parser fix is applied by re-parsing (reparse-foodcom.ts),
// never re-crawling. Polite 2s pause; resumable (skips recipes whose raw is already stored);
// aborts on a run of failures.
//
// Usage: pnpm --filter @meals/api exec tsx src/scripts/crawl-foodcom-raw.ts [--delay 2000] [--limit N] [--refetch]

import { prisma } from '@meals/db';
import { fetchRecipeRaw } from '@meals/ingestion';
import { loadLinkContext, enrichRecipe } from '../lib/recipeIngest.js';

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function foodcomUrl(externalId: string | null, sourceUrl: string | null): { id: string; url: string } | null {
  const m = externalId?.match(/^foodcom:(\d+)$/) ?? sourceUrl?.match(/recipe\/(?:[a-z0-9-]*-)?(\d+)/i);
  // food.com 404s the bare numeric URL but resolves by the trailing id with any slug.
  return m ? { id: m[1]!, url: `https://www.food.com/recipe/recipe-${m[1]}` } : null;
}

async function main() {
  const delay = Number(arg('--delay') ?? 2000);
  const limit = Number(arg('--limit') ?? Infinity);
  const refetch = process.argv.includes('--refetch');
  const household = await prisma.household.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const ctx = await loadLinkContext();

  // Recipes whose raw isn't cached yet (unless --refetch).
  const cached = refetch
    ? new Set<string>()
    : new Set((await prisma.recipeRawFetch.findMany({ select: { externalId: true } })).map((r) => r.externalId));

  const recipes = await prisma.recipe.findMany({
    where: { householdId: household.id, sourceName: 'Food.com', externalId: { not: null } },
    select: { id: true, externalId: true, sourceUrl: true, servings: true, instructions: true, imageUrl: true, prepMinutes: true, cuisine: true, category: true },
    orderBy: { externalRatingCount: 'desc' },
  });
  const todo = recipes.filter((r) => refetch || !cached.has(r.externalId!)).slice(0, limit === Infinity ? undefined : limit);
  console.log(`${todo.length} recipes to fetch (${cached.size} already cached); ${delay}ms pause`);

  let fetched = 0;
  let enriched = 0;
  let failed = 0;
  let consec = 0;
  const started = Date.now();
  for (let i = 0; i < todo.length; i++) {
    const r = todo[i]!;
    const fc = foodcomUrl(r.externalId, r.sourceUrl);
    if (!fc) {
      failed++;
      continue;
    }
    try {
      const { node, normalized } = await fetchRecipeRaw(fc.url);
      await prisma.recipeRawFetch.upsert({
        where: { externalId: r.externalId! },
        create: { externalId: r.externalId!, sourceUrl: fc.url, raw: node as object },
        update: { raw: node as object, sourceUrl: fc.url, fetchedAt: new Date() },
      });
      fetched++;
      const { enriched: did } = await enrichRecipe(r, normalized, ctx);
      if (did) enriched++;
      consec = 0;
    } catch {
      failed++;
      consec++;
      if (consec >= 25) {
        console.error(`\nAborting: ${consec} consecutive failures (likely blocked). Re-run to resume.`);
        break;
      }
    }
    if ((i + 1) % 25 === 0 || i + 1 === todo.length) {
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      process.stdout.write(`\r  ${i + 1}/${todo.length} — fetched ${fetched}, enriched ${enriched}, failed ${failed} (${mins}m)`);
    }
    await sleep(delay);
  }
  console.log(`\nDONE — cached ${fetched} raw, enriched ${enriched}, failed ${failed}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
