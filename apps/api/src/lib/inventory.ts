import { prisma } from '@meals/db';

// FIFO-by-expiry pantry deduction, shared by POST /inventory/consume and recipe cooking.
export async function consumeFromInventory(
  householdId: string,
  canonicalItemId: string,
  baseQuantity: number,
): Promise<{ consumedLotIds: string[]; shortfallBase: number }> {
  let remaining = baseQuantity;

  const lots = await prisma.inventoryLot.findMany({
    where: { householdId, canonicalItemId },
    orderBy: [{ expiresAt: 'asc' }, { purchasedAt: 'asc' }],
  });

  const consumed: string[] = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
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
        data: {
          baseQuantity: left.toString(),
          quantity: (Number(lot.quantity) * ratio).toString(),
        },
      });
      remaining = 0;
    }
  }
  return { consumedLotIds: consumed, shortfallBase: Math.max(0, remaining) };
}

/** Current pantry totals in base units, keyed by canonical item id. */
export async function pantryTotals(householdId: string): Promise<Map<string, number>> {
  const rows = await prisma.inventoryLot.groupBy({
    by: ['canonicalItemId'],
    where: { householdId },
    _sum: { baseQuantity: true },
  });
  return new Map(rows.map((r) => [r.canonicalItemId, Number(r._sum.baseQuantity ?? 0)]));
}
