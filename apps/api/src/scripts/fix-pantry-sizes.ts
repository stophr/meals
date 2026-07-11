/**
 * Fill pack sizes for pantry lots that came in sizeless (scanned items that resolved via a source
 * without a size, so the lot defaulted to "1 each" instead of e.g. "1.5 oz"). For each such lot's
 * product we re-query for a size — Kroger by UPC (now 13-digit padded), then UPCitemdb, then the
 * size embedded in the product name, then Open Food Facts — and when we find one, write it onto
 * the corpus Product AND rewrite the default "1 each" lot to the container's real contents.
 * Leaves lots the user already sized (anything not 1 each) alone. Idempotent.
 *
 * Usage: pnpm --filter @meals/api exec tsx src/scripts/fix-pantry-sizes.ts
 */
import { prisma } from '@meals/db';
import { toBaseQuantity } from '@meals/core';
import { getProductByUpc, lookupUpcItemDb } from '@meals/ingestion';
import { krogerConfig, getAppToken, krogerLocationId } from '../lib/kroger.js';
import { lookupOpenFoodFacts } from '../lib/offProduct.js';
import { parseQuantityText } from '../lib/upcUtil.js';
import { env } from '../env.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sizeFor(upc: string, description: string, krCfg: ReturnType<typeof krogerConfig>, krToken: string | null, loc?: string) {
  // a) Kroger by UPC (padded inside getProductByUpc).
  if (krCfg && krToken) {
    const k = await getProductByUpc(krCfg, krToken, upc, loc).catch(() => null);
    const s = k?.size ? parseQuantityText(k.size) : null;
    if (s) return { ...s, src: 'kroger' };
  }
  // b) UPCitemdb (size field, else parse it out of the title).
  const u = await lookupUpcItemDb({ key: env.UPCITEMDB_KEY || undefined, baseUrl: env.UPCITEMDB_API_BASE }, upc).catch(() => null);
  const uSize = u ? parseQuantityText(u.sizeText ?? u.description) : null;
  if (uSize) return { ...uSize, src: 'upcitemdb' };
  // c) Embedded in the name we already stored.
  const nameSize = parseQuantityText(description);
  if (nameSize) return { ...nameSize, src: 'name' };
  // d) Open Food Facts quantity.
  const off = await lookupOpenFoodFacts(upc).catch(() => null);
  const oSize = off?.quantity ? parseQuantityText(off.quantity) : null;
  if (oSize) return { ...oSize, src: 'off' };
  return null;
}

async function main() {
  const krCfg = krogerConfig();
  const krToken = krCfg ? await getAppToken(krCfg).catch(() => null) : null;
  const loc = (await prisma.provider.findMany()).map((p) => krogerLocationId(p)).find((x): x is string => !!x);

  // Sizeless default lots: 1 each, linked to a product that has no parsed pack unit.
  const lots = await prisma.inventoryLot.findMany({
    where: { unit: 'EACH', quantity: 1, product: { is: { packUnit: null } } },
    include: { product: { select: { id: true, upc: true, description: true } }, canonicalItem: { select: { name: true } } },
  });
  // De-dup products (several lots can share one); skip any without a real UPC to look up.
  type Lot = (typeof lots)[number];
  const byProduct = new Map<string, Lot[]>();
  for (const l of lots) {
    if (!l.product?.upc) continue;
    const arr = byProduct.get(l.product.id) ?? [];
    arr.push(l);
    byProduct.set(l.product.id, arr);
  }
  console.log(`${lots.length} sizeless "1 each" lots across ${byProduct.size} products.`);

  let fixed = 0;
  let unknown = 0;
  for (const [productId, group] of byProduct) {
    const p = group[0]!.product!;
    await sleep(300); // pace external calls politely
    const size = await sizeFor(p.upc!, p.description, krCfg, krToken, loc);
    if (!size) {
      unknown++;
      console.log(`  ? ${group[0]!.canonicalItem.name} (${p.description.slice(0, 30)}) — no size found; leave for manual entry`);
      continue;
    }
    const base = toBaseQuantity(size.quantity, size.unit as never).baseQuantity;
    // Enrich the corpus product so future scans of this UPC know the size.
    await prisma.product.update({
      where: { id: productId },
      data: {
        sizeText: `${size.quantity} ${size.unit.toLowerCase()}`,
        packSize: String(size.quantity),
        packUnit: size.unit as never,
        baseQuantity: base.toString(),
      },
    });
    // Rewrite the default lots to the container's real contents.
    for (const l of group) {
      await prisma.inventoryLot.update({
        where: { id: l.id },
        data: { quantity: String(size.quantity), unit: size.unit as never, baseQuantity: base.toString() },
      });
    }
    fixed += group.length;
    console.log(`  ✓ ${group[0]!.canonicalItem.name}: ${size.quantity} ${size.unit} (via ${size.src}) — ${group.length} lot(s)`);
  }

  console.log(`\nDone. Fixed ${fixed} lot(s); ${unknown} product(s) still unknown (editable in the pantry).`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
