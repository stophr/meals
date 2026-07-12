/**
 * Merge duplicate corpus rows created before the UPC-key fix: a scanned item that resolved via
 * Open Food Facts got its own row keyed by the raw UPC-A, separate from the crawled Kroger row
 * keyed by Kroger's check-digit-less form. For each non-Kroger row that has a Kroger twin (same
 * product by krogerProductKey), repoint references to the Kroger row, delete the OFF row, and
 * delete its now-orphaned cached image file — we keep the Kroger record + Kroger image. OFF rows
 * with no Kroger twin (items Fry's doesn't carry) are left as-is. Idempotent.
 *
 * Usage: pnpm --filter @meals/api exec tsx src/scripts/dedup-off-products.ts
 */
import { unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { prisma } from '@meals/db';
import { krogerProductKey } from '../lib/upcUtil.js';

const IMG_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../data/product-images');
const fileFor = (upc: string) => `${upc.replace(/[^a-zA-Z0-9]/g, '_')}.jpg`;

async function main() {
  const scanned = await prisma.product.findMany({
    where: { descriptionSource: { not: 'KROGER' } },
    select: { id: true, upc: true, description: true },
  });

  let merged = 0;
  let filesDeleted = 0;
  let noTwin = 0;
  for (const p of scanned) {
    const key = krogerProductKey(p.upc);
    if (!key || key === p.upc) continue; // plu:/manual: pseudo-UPCs, or already canonical
    const keeper = await prisma.product.findFirst({
      where: { upc: key, descriptionSource: 'KROGER', id: { not: p.id } },
      select: { id: true, description: true },
    });
    if (!keeper) {
      noTwin++;
      continue;
    }
    // Repoint everything that referenced the OFF row to the Kroger row, then drop the OFF row.
    await prisma.$transaction([
      prisma.inventoryLot.updateMany({ where: { productId: p.id }, data: { productId: keeper.id } }),
      prisma.canonicalItem.updateMany({ where: { referenceProductId: p.id }, data: { referenceProductId: keeper.id } }),
      prisma.product.delete({ where: { id: p.id } }),
    ]);
    // Sweep the orphaned OFF image file.
    const f = join(IMG_DIR, fileFor(p.upc));
    if (existsSync(f)) {
      unlinkSync(f);
      filesDeleted++;
    }
    merged++;
    console.log(`  merged "${p.description.slice(0, 30)}" (${p.upc}) → Kroger "${keeper.description.slice(0, 30)}"`);
  }
  console.log(`\nDone. Merged ${merged} OFF rows into their Kroger twin; deleted ${filesDeleted} orphan image(s); ${noTwin} OFF rows had no Kroger twin (kept).`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
