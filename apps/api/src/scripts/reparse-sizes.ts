/**
 * Re-derive packSize/packUnit/baseQuantity for every corpus Product from the raw sizeText we
 * already stored during the crawl, using the improved parseQuantityText (multipacks, fractions,
 * count packs). No network — Fry's already gave us the size string; this just parses it better.
 * Idempotent; only writes rows whose parsed size changed.
 *
 * Usage: pnpm --filter @meals/api exec tsx src/scripts/reparse-sizes.ts
 */
import { prisma } from '@meals/db';
import { toBaseQuantity } from '@meals/core';
import { parseQuantityText } from '../lib/upcUtil.js';

const BATCH = 500;

async function main() {
  let cursor = '';
  let scanned = 0;
  let changed = 0;
  let newlyParsed = 0;
  const started = Date.now();

  for (;;) {
    const batch = await prisma.product.findMany({
      where: { id: { gt: cursor }, sizeText: { not: null } },
      orderBy: { id: 'asc' },
      take: BATCH,
      select: { id: true, sizeText: true, packSize: true, packUnit: true },
    });
    if (!batch.length) break;

    for (const p of batch) {
      scanned++;
      cursor = p.id;
      const size = parseQuantityText(p.sizeText);
      const newUnit = size?.unit ?? null;
      const newPack = size ? String(size.quantity) : null;
      const newBase = size ? toBaseQuantity(size.quantity, size.unit as never).baseQuantity.toString() : null;

      const oldUnit = p.packUnit ?? null;
      const oldPack = p.packSize != null ? String(Number(p.packSize)) : null;
      if (oldUnit === newUnit && oldPack === newPack) continue;

      await prisma.product.update({
        where: { id: p.id },
        data: { packSize: newPack, packUnit: newUnit as never, baseQuantity: newBase },
      });
      changed++;
      if (oldUnit == null && newUnit != null) newlyParsed++;
    }
    console.log(`  scanned ${scanned} | changed ${changed} | newly-parsed ${newlyParsed}`);
  }

  const withUnit = await prisma.product.count({ where: { packUnit: { not: null } } });
  console.log(
    `\nDone in ${Math.round((Date.now() - started) / 1000)}s. Scanned ${scanned}, changed ${changed} ` +
      `(${newlyParsed} were previously unparsed). Products with a parsed size now: ${withUnit}.`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
