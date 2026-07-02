import { prisma } from '@meals/db';
import type { Unit } from '@meals/db';
import { dimensionOf } from '@meals/core';
import type { UnitDimension } from '@meals/shared';

// Pantry math is DIMENSION-AWARE: a weight stock (grams) and a volume/count need are never
// netted against each other. "50 each Sugar" cannot satisfy "300 g sugar" — different
// measurement types — so it isn't deducted or counted as covered.

/** Deduct a quantity FIFO-by-expiry, only from lots whose measurement type matches. */
export async function consumeFromInventory(
  householdId: string,
  canonicalItemId: string,
  baseQuantity: number,
  dimension: UnitDimension,
): Promise<{ consumedLotIds: string[]; shortfallBase: number }> {
  let remaining = baseQuantity;

  const lots = await prisma.inventoryLot.findMany({
    where: { householdId, canonicalItemId },
    orderBy: [{ expiresAt: 'asc' }, { purchasedAt: 'asc' }],
  });

  const consumed: string[] = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    if (dimensionOf(lot.unit as Unit) !== dimension) continue; // different measurement type
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

/** Pantry totals in base units, keyed by canonical item id THEN measurement dimension. */
export async function pantryByItemDim(
  householdId: string,
): Promise<Map<string, Map<UnitDimension, number>>> {
  const lots = await prisma.inventoryLot.findMany({
    where: { householdId },
    select: { canonicalItemId: true, unit: true, baseQuantity: true },
  });
  const map = new Map<string, Map<UnitDimension, number>>();
  for (const lot of lots) {
    const dim = dimensionOf(lot.unit as Unit);
    let byDim = map.get(lot.canonicalItemId);
    if (!byDim) {
      byDim = new Map();
      map.set(lot.canonicalItemId, byDim);
    }
    byDim.set(dim, (byDim.get(dim) ?? 0) + Number(lot.baseQuantity));
  }
  return map;
}
