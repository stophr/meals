/**
 * Pre-download the MEDIUM product image for every corpus Product into PRODUCT_IMAGE_DIR/<upc>.jpg
 * so the app serves images from our host (fast, offline-capable, no Kroger CDN dependency at
 * browse time). Images are shared globally by UPC, so this benefits every household + location.
 *
 * Trails the catalog crawl: by default it loops, draining Products with imageCached=false, then
 * polls for newly-crawled rows. `imageCached` means "attempted" (success OR a definitive 404) so
 * dead URLs aren't retried forever; the serving route checks the actual file, not just the flag.
 * These are CDN fetches (not Kroger's rate-capped Products API).
 *
 * Usage: pnpm --filter @meals/api exec tsx src/scripts/download-product-images.ts [--once] [--dir <path>]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { prisma } from '@meals/db';

// Repo-root data/product-images regardless of CWD (pnpm --filter runs from apps/api). This is the
// dir bind-mounted into the api container as PRODUCT_IMAGE_DIR.
const REPO_IMAGES = join(dirname(fileURLToPath(import.meta.url)), '../../../../data/product-images');

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ONCE = process.argv.includes('--once');
const DIR = arg('--dir') ?? REPO_IMAGES;
const CONCURRENCY = 5;
const BATCH = 200;

// Kroger CDN serves sizes at /images/<size>/... — normalize any variant to medium (~10 KB).
function mediumUrl(url: string): string {
  return url.replace(/\/images\/[a-zA-Z]+\//, '/images/medium/');
}
// Safe filename from a UPC/PLU key (e.g. "plu:4011" -> "plu_4011").
const fileFor = (upc: string) => `${upc.replace(/[^a-zA-Z0-9]/g, '_')}.jpg`;

async function fetchOne(p: { id: string; upc: string; imageUrl: string | null }): Promise<'ok' | 'gone' | 'retry'> {
  if (!p.imageUrl) return 'gone';
  const url = p.imageUrl.includes('kroger.com') ? mediumUrl(p.imageUrl) : p.imageUrl;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'follow' });
    if (res.status === 404 || res.status === 403 || res.status === 410) return 'gone';
    if (!res.ok) return 'retry';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) return 'gone'; // tiny = placeholder/error image
    writeFileSync(join(DIR, fileFor(p.upc)), buf);
    return 'ok';
  } catch {
    return 'retry';
  }
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  console.log(`Downloading medium images -> ${DIR} (concurrency ${CONCURRENCY}${ONCE ? ', single pass' : ', looping'})`);
  let ok = 0;
  let gone = 0;
  let emptyPolls = 0;
  const started = Date.now();

  for (;;) {
    const batch = await prisma.product.findMany({
      where: { imageCached: false, imageUrl: { not: null } },
      select: { id: true, upc: true, imageUrl: true },
      take: BATCH,
      orderBy: { updatedAt: 'desc' }, // freshest crawled first
    });
    // Nothing to do right now. In --once mode that means we're done; while trailing a live crawl
    // an empty batch is usually just a lull, so poll a while before concluding it's finished.
    // (An empty batch always implies count == 0 — they share a filter — so we must NOT exit on
    // the first empty poll, or a mid-crawl gap ends the worker early, as it did before.)
    if (!batch.length) {
      emptyPolls++;
      if (ONCE || emptyPolls >= 20) {
        const total = await prisma.product.count({ where: { imageCached: true } });
        console.log(`\nDone. Cached this run: ${ok} ok, ${gone} missing. Total attempted: ${total}. ${Math.round((Date.now() - started) / 60000)}m`);
        break;
      }
      await sleep(30_000); // wait ~10 min of quiet (20 polls) before deciding the crawl is over
      continue;
    }
    emptyPolls = 0;

    // Process the batch in small concurrent chunks.
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const chunk = batch.slice(i, i + CONCURRENCY);
      const results = await Promise.all(chunk.map(fetchOne));
      const cachedIds: string[] = [];
      for (let j = 0; j < chunk.length; j++) {
        const r = results[j]!;
        if (r === 'ok') { ok++; cachedIds.push(chunk[j]!.id); }
        else if (r === 'gone') { gone++; cachedIds.push(chunk[j]!.id); } // mark attempted; no retry
        // 'retry' -> leave imageCached=false for a later pass
      }
      if (cachedIds.length) await prisma.product.updateMany({ where: { id: { in: cachedIds } }, data: { imageCached: true } });
      await sleep(120);
    }
    if ((ok + gone) % 1000 < CONCURRENCY) {
      console.log(`  cached ${ok} ok / ${gone} missing (${Math.round(ok / Math.max((Date.now() - started) / 60000, 0.1))}/min)`);
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
