// Backfill images for Product rows that have none (e.g. products cached before image support).
// Open Food Facts first (free), UPCitemdb only when OFF has no image (its trial tier is
// quota-limited, so it's paced and used sparingly). Idempotent — re-run any time; it only
// touches rows still missing an image.

import { prisma } from '@meals/db';
import { lookupOpenFoodFacts } from '../lib/offProduct.js';
import { lookupUpcItemDb } from '@meals/ingestion';
import { env } from '../env.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const rows = await prisma.product.findMany({
    where: { imageUrl: null },
    select: { id: true, upc: true, description: true },
  });
  console.log(`${rows.length} product(s) without an image\n`);

  let off = 0;
  let updb = 0;
  let none = 0;
  for (const p of rows) {
    let image: string | null = null;
    let src = '';

    const o = await lookupOpenFoodFacts(p.upc).catch(() => null);
    if (o?.imageUrl) {
      image = o.imageUrl;
      src = 'OFF';
    }
    if (!image) {
      await sleep(1200); // pace UPCitemdb (trial rate limit + daily quota)
      const u = await lookupUpcItemDb(
        { key: env.UPCITEMDB_KEY || undefined, baseUrl: env.UPCITEMDB_API_BASE },
        p.upc,
      ).catch(() => null);
      if (u?.imageUrl) {
        image = u.imageUrl;
        src = 'UPCITEMDB';
      }
    }

    if (image) {
      await prisma.product.update({ where: { id: p.id }, data: { imageUrl: image } });
      src === 'OFF' ? off++ : updb++;
      console.log(`  ✓ ${p.upc}  ${p.description}  ←  ${src}`);
    } else {
      none++;
      console.log(`  ·  ${p.upc}  ${p.description}  (no image found)`);
    }
    await sleep(400);
  }

  console.log(`\nDONE — images set from OFF ${off}, UPCitemdb ${updb}; still missing ${none}.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
