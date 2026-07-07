// Bulk price sync: pull real Fry's/Kroger prices for EVERY canonical item (not just one
// shopping list) so recipes can be costed. ~1s/item against the Products API — a full run
// over ~1,600 items takes ~25 minutes and sits far below the 10K/day limit.
//
// Usage:
//   pnpm --filter @meals/api exec tsx src/scripts/sync-all-prices.ts [--stale-days 6] [--limit N]
//
// Idempotent: items with a price newer than --stale-days are skipped, so re-runs only top up.

import { prisma } from '@meals/db';
import { krogerConfig, krogerLocationId, syncPrices } from '../lib/kroger.js';

function arg(f: string): string | undefined {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const cfg = krogerConfig();
  if (!cfg) throw new Error('Kroger not configured (KROGER_CLIENT_ID/SECRET)');
  const staleDays = Number(arg('--stale-days') ?? 6);
  const limit = Number(arg('--limit') ?? Infinity);

  const household = await prisma.household.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const providers = await prisma.provider.findMany({ where: { householdId: household.id } });
  const provider = providers.find((p) => krogerLocationId(p));
  if (!provider) throw new Error('No provider linked to a Kroger location');

  // Items with no fresh price at this provider.
  const freshCutoff = new Date(Date.now() - staleDays * 86_400_000);
  const fresh = await prisma.providerProduct.findMany({
    where: {
      storeLocationId: provider.storeLocationId ?? '',
      canonicalItemId: { not: null },
      prices: { some: { observedAt: { gte: freshCutoff } } },
    },
    select: { canonicalItemId: true },
  });
  const freshIds = new Set(fresh.map((f) => f.canonicalItemId!));
  const all = await prisma.canonicalItem.findMany({ select: { id: true } });
  const todo = all.filter((i) => !freshIds.has(i.id)).slice(0, limit === Infinity ? undefined : limit);
  console.log(`${all.length} items total; ${freshIds.size} fresh; syncing ${todo.length} at ${provider.name}`);

  const CHUNK = 25;
  let done = 0;
  let priced = 0;
  let unmatched = 0;
  const started = Date.now();
  for (let i = 0; i < todo.length; i += CHUNK) {
    const ids = todo.slice(i, i + CHUNK).map((x) => x.id);
    const res = await syncPrices(cfg, provider, ids);
    done += res.itemsQueried;
    priced += res.pricesRecorded;
    unmatched += res.unmatched.length;
    const rate = done / ((Date.now() - started) / 1000);
    const eta = Math.round((todo.length - done) / rate / 60);
    console.log(`${done}/${todo.length} priced=${priced} unmatched=${unmatched} (~${eta}min left)`);
  }
  console.log(`DONE in ${Math.round((Date.now() - started) / 60000)}min — priced ${priced}, no Fry's match for ${unmatched}`);
  console.log('Next: recompute recipe costs ->');
  console.log('  pnpm --filter @meals/api exec tsx src/scripts/recompute-costs.ts');
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
