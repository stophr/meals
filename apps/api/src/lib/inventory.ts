import { prisma } from '@meals/db';
import type { Unit } from '@meals/db';
import { dimensionOf } from '@meals/core';
import {
  baseToGrams,
  gramsToBase,
  type UnitDimension,
  type DensityFactors,
  type DimensionedAmount,
} from '@meals/shared';

// Pantry math is DIMENSION-AWARE, bridged by per-item density when available: a weight in the
// pantry can satisfy a volume need ("5 lb sugar" covers "2 cups sugar") when the item carries
// a gramsPerMl/gramsPerEach factor. Without a factor, weight and volume never cross-net.

function factorsFor(item: { gramsPerMl?: unknown; gramsPerEach?: unknown } | null): DensityFactors {
  return {
    gramsPerMl: item?.gramsPerMl != null ? Number(item.gramsPerMl) : null,
    gramsPerEach: item?.gramsPerEach != null ? Number(item.gramsPerEach) : null,
  };
}

/**
 * Deduct a quantity FIFO-by-expiry. Bridges dimensions via the item's density when the whole
 * set of lots is convertible; otherwise only same-dimension lots are touched.
 */
export async function consumeFromInventory(
  householdId: string,
  canonicalItemId: string,
  baseQuantity: number,
  dimension: UnitDimension,
): Promise<{ consumedLotIds: string[]; shortfallBase: number }> {
  const [item, lots] = await Promise.all([
    prisma.canonicalItem.findUnique({
      where: { id: canonicalItemId },
      select: { gramsPerMl: true, gramsPerEach: true },
    }),
    prisma.inventoryLot.findMany({
      where: { householdId, canonicalItemId },
      orderBy: [{ expiresAt: 'asc' }, { purchasedAt: 'asc' }],
    }),
  ]);
  const f = factorsFor(item);

  // Prefer the grams pivot so weight stock can satisfy a volume/count need (and vice versa).
  // Lots we can't convert are skipped, not a reason to abandon the grams path entirely.
  const needG = baseToGrams(baseQuantity, dimension, f);
  const consumed: string[] = [];

  if (needG != null) {
    let remaining = needG;
    for (const lot of lots) {
      if (remaining <= 1e-6) break;
      const lotDim = dimensionOf(lot.unit as Unit);
      const lotG = baseToGrams(Number(lot.baseQuantity), lotDim, f);
      if (lotG == null) continue; // can't convert this lot to grams — leave it alone
      if (lotG <= remaining + 1e-6) {
        remaining -= lotG;
        await prisma.inventoryLot.delete({ where: { id: lot.id } });
        consumed.push(lot.id);
      } else {
        const leftG = lotG - remaining;
        const ratio = leftG / lotG;
        await prisma.inventoryLot.update({
          where: { id: lot.id },
          data: {
            baseQuantity: (gramsToBase(leftG, lotDim, f) ?? Number(lot.baseQuantity) * ratio).toString(),
            quantity: (Number(lot.quantity) * ratio).toString(),
          },
        });
        remaining = 0;
      }
    }
    return { consumedLotIds: consumed, shortfallBase: gramsToBase(Math.max(0, remaining), dimension, f) ?? 0 };
  }

  // Fallback: same-dimension only.
  let remaining = baseQuantity;
  for (const lot of lots) {
    if (remaining <= 1e-6) break;
    if (dimensionOf(lot.unit as Unit) !== dimension) continue;
    const lotBase = Number(lot.baseQuantity);
    if (lotBase <= remaining) {
      remaining -= lotBase;
      await prisma.inventoryLot.delete({ where: { id: lot.id } });
      consumed.push(lot.id);
    } else {
      const left = lotBase - remaining;
      const ratio = left / lotBase;
      await prisma.inventoryLot.update({
        where: { id: lot.id },
        data: { baseQuantity: left.toString(), quantity: (Number(lot.quantity) * ratio).toString() },
      });
      remaining = 0;
    }
  }
  return { consumedLotIds: consumed, shortfallBase: Math.max(0, remaining) };
}

/** Every pantry lot as a {base, dim} amount, keyed by canonical item id. */
export async function pantryLots(householdId: string): Promise<Map<string, DimensionedAmount[]>> {
  const lots = await prisma.inventoryLot.findMany({
    where: { householdId },
    select: { canonicalItemId: true, unit: true, baseQuantity: true },
  });
  const map = new Map<string, DimensionedAmount[]>();
  for (const lot of lots) {
    const amt: DimensionedAmount = {
      base: Number(lot.baseQuantity),
      dim: dimensionOf(lot.unit as Unit),
    };
    const list = map.get(lot.canonicalItemId);
    if (list) list.push(amt);
    else map.set(lot.canonicalItemId, [amt]);
  }
  return map;
}
