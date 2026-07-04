// Slow crawler: enrich Food.com recipes by fetching their live pages and replacing the thin
// Kaggle-dataset ingredient lists with the complete JSON-LD (units + missing items like the
// jalapeños). Polite: 2s pause between fetches (food.com/robots.txt permits /recipe/ and sets
// no crawl-delay). Resumable + idempotent: processed recipes get an 'enriched' tag and are
// skipped; failures are left untagged and retried on the next run. Aborts on a run of failures
// (likely a block) instead of hammering.
//
// Usage: pnpm --filter @meals/api exec tsx src/scripts/enrich-foodcom.ts [--delay 2000] [--limit N]

import { prisma } from '@meals/db';
import { importRecipeFromUrl } from '@meals/ingestion';
import { loadLinkContext, enrichRecipe } from '../lib/recipeIngest.js';

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function foodcomUrl(externalId: string | null, sourceUrl: string | null): string | null {
  // food.com 404s the bare numeric URL but resolves by the trailing id with ANY slug, so a
  // placeholder slug + id redirects to the canonical recipe page.
  const m = externalId?.match(/^foodcom:(\d+)$/) ?? sourceUrl?.match(/recipe\/(?:[a-z0-9-]*-)?(\d+)/i);
  return m ? `https://www.food.com/recipe/recipe-${m[1]}` : null;
}

async function main() {
  const delay = Number(arg('--delay') ?? 2000);
  const limit = Number(arg('--limit') ?? Infinity);
  // The active tenant is the oldest household (same as the API's getHousehold()).
  const household = await prisma.household.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const ctx = await loadLinkContext(household.id);

  const recipes = await prisma.recipe.findMany({
    where: {
      householdId: household.id,
      sourceName: 'Food.com',
      NOT: { tags: { has: 'enriched' } },
    },
    select: {
      id: true,
      externalId: true,
      sourceUrl: true,
      servings: true,
      instructions: true,
      imageUrl: true,
      prepMinutes: true,
      cuisine: true,
      category: true,
    },
    orderBy: { externalRatingCount: 'desc' }, // most popular first
    take: limit === Infinity ? undefined : limit,
  });
  console.log(`${recipes.length} Food.com recipes to enrich; ${delay}ms pause between fetches`);

  let enriched = 0;
  let unchanged = 0;
  let failed = 0;
  let consecFail = 0;
  const started = Date.now();

  for (let i = 0; i < recipes.length; i++) {
    const r = recipes[i]!;
    const url = foodcomUrl(r.externalId, r.sourceUrl);
    if (!url) {
      failed++;
      continue;
    }
    try {
      const normalized = await importRecipeFromUrl(url);
      const { enriched: didEnrich } = await enrichRecipe(r, normalized, ctx);
      didEnrich ? enriched++ : unchanged++;
      // Mark processed (preserve existing tags).
      await prisma.recipe.update({ where: { id: r.id }, data: { tags: { push: 'enriched' } } });
      consecFail = 0;
    } catch {
      failed++;
      consecFail++;
      if (consecFail >= 25) {
        console.error(`\nAborting: ${consecFail} consecutive fetch failures (likely rate-limited/blocked). Re-run later — it resumes.`);
        break;
      }
    }
    if ((i + 1) % 25 === 0 || i + 1 === recipes.length) {
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      process.stdout.write(`\r  ${i + 1}/${recipes.length} — enriched ${enriched}, unchanged ${unchanged}, failed ${failed} (${mins}m)`);
    }
    await sleep(delay);
  }
  console.log(`\nDONE — enriched ${enriched}, unchanged ${unchanged}, failed ${failed}. Run recompute-costs after.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
