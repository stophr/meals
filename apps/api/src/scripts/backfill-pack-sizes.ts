// Backfill ProviderProduct.packSize / packUnit / baseQuantity from the free-text sizeText
// ("1 lb", "750 ml", "1 ct"). Without a normalized pack size, per-unit pricing, packs-needed,
// and the density bridge all have nothing to work with. Idempotent: only touches rows whose
// baseQuantity is still null.
//
// Usage: pnpm --filter @meals/api exec tsx src/scripts/backfill-pack-sizes.ts [--force]

import { prisma } from '@meals/db';
import type { Unit } from '@meals/db';
import { parseIngredientLine, toBaseQuantity } from '@meals/core';

// Count-style size words the ingredient parser doesn't map to a unit.
const COUNT_WORDS: Record<string, Unit> = {
  ct: 'EACH', count: 'EACH', ea: 'EACH', each: 'EACH', pc: 'EACH', pcs: 'EACH', piece: 'EACH',
  pk: 'PACK', pack: 'PACK', pkg: 'PACK', package: 'PACK', ct_pack: 'PACK',
  dozen: 'EACH', doz: 'EACH',
};

// US volume units missing from the Unit enum — normalized to L / ML.
function usVolume(n: number, word: string): { qty: number; unit: Unit } | null {
  if (/^gal(lon)?s?$/.test(word)) return { qty: n * 3.78541, unit: 'L' };
  if (/^(qt|quarts?)$/.test(word)) return { qty: n * 0.946353, unit: 'L' };
  if (/^(pt|pints?)$/.test(word)) return { qty: n * 473.176, unit: 'ML' };
  return null;
}

function parseSize(sizeText: string): { qty: number; unit: Unit } | null {
  let t = sizeText.trim().toLowerCase().replace(/\bfo\b/, 'fl oz'); // "19 fo" -> fl oz
  // "4 sticks / 16 oz" — the part after the slash is the real weight/volume.
  if (t.includes('/')) t = t.split('/').pop()!.trim();

  const p = parseIngredientLine(t);
  if (p.quantity && p.unit) {
    if (/\bdoz(en)?\b/.test(t)) return { qty: p.quantity * 12, unit: 'EACH' };
    return { qty: p.quantity, unit: p.unit };
  }
  const m = t.match(/(\d+(?:\.\d+)?)\s*([a-z]+)/);
  if (m) {
    const n = Number(m[1]);
    const word = m[2]!;
    if (n <= 0) return null;
    if (/^doz/.test(word)) return { qty: n * 12, unit: 'EACH' };
    const vol = usVolume(n, word);
    if (vol) return vol;
    const u = COUNT_WORDS[word];
    if (u) return { qty: n, unit: u };
  }
  return null;
}

const force = process.argv.includes('--force');

async function main() {
  const products = await prisma.providerProduct.findMany({
    where: { sizeText: { not: null }, ...(force ? {} : { baseQuantity: null }) },
    select: { id: true, sizeText: true },
  });
  console.log(`${products.length} product(s) with size text to parse`);

  let filled = 0;
  const unparsed = new Map<string, number>();
  for (const p of products) {
    const parsed = parseSize(p.sizeText!);
    if (!parsed) {
      unparsed.set(p.sizeText!, (unparsed.get(p.sizeText!) ?? 0) + 1);
      continue;
    }
    const base = toBaseQuantity(parsed.qty, parsed.unit);
    await prisma.providerProduct.update({
      where: { id: p.id },
      data: {
        packSize: parsed.qty.toString(),
        packUnit: parsed.unit,
        baseQuantity: base.baseQuantity.toString(),
      },
    });
    filled++;
  }

  console.log(`Filled pack size on ${filled} product(s)`);
  if (unparsed.size) {
    const top = [...unparsed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    console.log(`Unparsed (${[...unparsed.values()].reduce((a, b) => a + b, 0)}): ${top.map(([s, n]) => `"${s}"×${n}`).join(', ')}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
