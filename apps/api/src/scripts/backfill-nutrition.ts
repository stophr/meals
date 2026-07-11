/**
 * Backfill per-serving nutrition so recipe/diet calories light up. Targets the products that
 * recipe nutrition actually reads — each canonical item's REFERENCE product — rather than the
 * whole 35k catalog (that includes non-food SKUs and wastes lookups). For each such product with
 * no nutrition yet, fetch USDA-by-name → USDA-by-UPC → Open Food Facts and store it (see
 * fillProductNutrition). Sweeps once by ascending id via a cursor, so products we can't find
 * data for ("nodata") are passed exactly once instead of being retried in a loop. Resumable: the
 * DB is the checkpoint (already-filled rows drop out of the `nutritionSource IS NULL` set), so a
 * restart just re-sweeps whatever's still empty.
 *
 * Paced to stay under the USDA FoodData Central hourly cap (~1000/hr per key). This is a
 * multi-day job for a large catalog — that's expected.
 *
 * Usage: pnpm --filter @meals/api exec tsx src/scripts/backfill-nutrition.ts
 *   [--max-per-hour 900] [--limit N]
 */
import { prisma } from '@meals/db';
import { fillProductNutrition } from '../lib/productCorpus.js';

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const maxPerHour = Number(arg('--max-per-hour') ?? process.env.USDA_MAX_CALLS_PER_HOUR ?? 900);
  const limit = Number(arg('--limit') ?? Infinity);
  const perCall = Math.max(300, Math.ceil(3_600_000 / maxPerHour)); // keep under the FDC cap

  const target = { nutritionSource: null, referenceFor: { some: {} } } as const;
  const remaining = await prisma.product.count({ where: target });
  const etaH = Math.round(((Math.min(remaining, limit) * perCall) / 3_600_000) * 10) / 10;
  console.log(
    `Nutrition backfill: ${remaining} products without nutrition. ~${maxPerHour}/hr (${perCall}ms/call) → ~${etaH}h if all sweep.`,
  );

  const BATCH = 200;
  let cursor = '';
  let filled = 0;
  let nodata = 0;
  let processed = 0;
  const started = Date.now();

  outer: for (;;) {
    const batch = await prisma.product.findMany({
      where: { ...target, id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: BATCH,
      select: { id: true, upc: true, description: true, nutritionSource: true, baseQuantity: true },
    });
    if (!batch.length) break;

    for (const p of batch) {
      if (processed >= limit) break outer;
      await sleep(perCall);
      try {
        const r = await fillProductNutrition(p);
        if (r === 'filled') filled++;
        else if (r === 'nodata') nodata++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/429|rate limit/i.test(msg)) {
          console.log('  rate limited — backing off 60s');
          await sleep(60_000);
        }
      }
      processed++;
      cursor = p.id;
    }
    const rate = Math.round(filled / Math.max((Date.now() - started) / 60_000, 0.1));
    console.log(`  processed ${processed} | filled ${filled} | no-data ${nodata} | ${rate}/min filled`);
  }

  const withNut = await prisma.product.count({ where: { nutritionSource: { not: null } } });
  console.log(
    `\nDone. Filled ${filled}, no-data ${nodata}, processed ${processed} in ${Math.round((Date.now() - started) / 60_000)}m. ` +
      `Corpus now has nutrition on ${withNut} products.`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
