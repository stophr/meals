// Crawl Kroger produce for GTINs and seed the local corpus, so scanning a produce barcode
// resolves from our own DB. Search terms = the distinct commodity words from the IFPS PLU list
// (apples, oranges, bananas, ...). Each returned product's GTIN/description/brand/size/image is
// upserted (descriptionSource=KROGER); nutrition fills lazily on first scan (USDA). Idempotent.
//
// Usage: pnpm --filter @meals/api exec tsx src/scripts/crawl-kroger-produce.ts [--location <id>]

import { prisma } from '@meals/db';
import { krogerConfig, getAppToken, krogerLocationId } from '../lib/kroger.js';
import { searchProducts, PLU_CODES } from '@meals/ingestion';
import { ingestKrogerProduct } from '../lib/productCorpus.js';

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = krogerConfig();
  if (!cfg) {
    console.error('No Kroger config (set KROGER_CLIENT_ID / KROGER_CLIENT_SECRET).');
    process.exit(1);
  }
  let loc = arg('--location');
  if (!loc) {
    const providers = await prisma.provider.findMany();
    loc = providers.map((p) => krogerLocationId(p)).find((x): x is string => !!x);
  }
  if (!loc) {
    console.error("No Kroger location — link a Fry's store or pass --location <id>.");
    process.exit(1);
  }

  // Distinct commodity words from the IFPS PLU list -> broad produce search terms.
  const STOP = new Set(['mix', 'blend', 'each', 'other', 'retailer', 'assigned', 'value', 'small', 'large', 'medium']);
  const terms = [
    ...new Set(
      Object.values(PLU_CODES).map((v) => v.trim().split(/\s+/).pop()!.toLowerCase().replace(/[^a-z]/g, '')),
    ),
  ]
    .filter((t) => t.length >= 3 && !STOP.has(t))
    .sort();

  console.log(`Crawling Kroger produce at location ${loc}: ${terms.length} commodity terms\n`);

  let seen = 0;
  let created = 0;
  let updated = 0;
  let failed = 0;
  let consec = 0;
  const started = Date.now();

  for (const [i, term] of terms.entries()) {
    await sleep(350); // pace politely — Kroger's edge is flaky under bursts
    let prods;
    try {
      const token = await getAppToken(cfg); // cached; auto-refreshes on expiry
      prods = await searchProducts(cfg, token, { term, locationId: loc, limit: 50, timeoutMs: 12000 });
      consec = 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/HTTP 4\d\d/.test(msg)) continue; // Kroger said "no results" for this term
      failed++;
      consec++;
      if (consec >= 12) {
        console.error(`\nAborting: ${consec} consecutive Kroger failures. Last: ${msg}`);
        break;
      }
      await sleep(Math.min(2000 * consec, 15000));
      continue;
    }
    for (const p of prods) {
      seen++;
      try {
        const r = await ingestKrogerProduct(p);
        if (r === 'created') created++;
        else if (r === 'updated') updated++;
      } catch {
        /* skip a bad row */
      }
    }
    if ((i + 1) % 20 === 0 || i + 1 === terms.length) {
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      process.stdout.write(
        `\r  ${i + 1}/${terms.length} terms — ${seen} products, ${created} new, ${updated} updated (${mins}m)`,
      );
    }
  }

  console.log(`\nDONE — ${seen} products seen, ${created} created, ${updated} updated, ${failed} failed.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
