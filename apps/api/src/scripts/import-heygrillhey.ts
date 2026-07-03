// Import recipes from heygrillhey.com into the catalog (additive — existing recipes stay).
// Discovers URLs from the site's own sitemap, imports each via its schema.org/Recipe JSON-LD,
// skips non-recipe posts, and dedupes by source URL (safe to re-run). Rate-limited to be a
// polite guest. heygrillhey.com/robots.txt permits general crawling.
//
// Usage: pnpm --filter @meals/api exec tsx src/scripts/import-heygrillhey.ts [--limit N] [--delay 900]

import { prisma } from '@meals/db';
import { importRecipeFromUrl } from '@meals/ingestion';
import { ingestRecipe } from '../lib/recipeIngest.js';

const SITEMAP = 'https://heygrillhey.com/post-sitemap.xml';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Obvious non-recipe slugs — skip up front to avoid needless requests.
const SKIP =
  /\/(about|contact|start-here|privacy|terms|disclosure|shop|store|membership|cookbook|the-grill-squad|feature-friday|web-stories|gift|newsletter|blog|guide-to|best-.*-recipes|how-to-.*-guide|world-record)/i;

async function main() {
  const limit = Number(arg('--limit') ?? Infinity);
  const delay = Number(arg('--delay') ?? 900);
  const household = await prisma.household.findFirstOrThrow();

  const xml = await (await fetch(SITEMAP, { headers: { 'user-agent': UA } })).text();
  const urls = [...xml.matchAll(/<loc>(https:\/\/heygrillhey\.com\/[a-z0-9-]+\/)<\/loc>/gi)]
    .map((m) => m[1]!)
    .filter((u) => !SKIP.test(u));
  const target = urls.slice(0, limit === Infinity ? undefined : limit);
  console.log(`${urls.length} candidate URLs (${target.length} to attempt); delay ${delay}ms`);

  let imported = 0;
  let duplicate = 0;
  let notRecipe = 0;
  let failed = 0;
  for (let i = 0; i < target.length; i++) {
    const url = target[i]!;
    try {
      const normalized = await importRecipeFromUrl(url);
      normalized.sourceName = 'Hey Grill Hey';
      normalized.tags = [...new Set([...(normalized.tags ?? []), 'heygrillhey', 'grilling'])];
      const { duplicate: dup } = await ingestRecipe(normalized, household.id);
      if (dup) duplicate++;
      else imported++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/No schema.org Recipe/.test(msg)) notRecipe++;
      else failed++;
    }
    if ((i + 1) % 25 === 0 || i + 1 === target.length) {
      process.stdout.write(
        `\r  ${i + 1}/${target.length} — imported ${imported}, dup ${duplicate}, non-recipe ${notRecipe}, failed ${failed}`,
      );
    }
    await sleep(delay);
  }
  console.log(`\nDONE — imported ${imported} new, ${duplicate} already present, ${notRecipe} non-recipe, ${failed} failed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
