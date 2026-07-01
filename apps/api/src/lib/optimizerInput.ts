import { prisma } from '@meals/db';
import type { OptimizerInput, OptimizerProvider } from '@meals/shared';

// Assemble the optimizer input from a persisted shopping list: for every item, price it at
// every provider that stocks a matched product with a currently-valid price.
export async function buildOptimizerInput(
  shoppingListId: string,
  householdId: string,
  timeValuePerMinute: number,
  maxStores?: number,
): Promise<{ input: OptimizerInput; itemToCanonical: Map<string, string> }> {
  const list = await prisma.shoppingList.findFirstOrThrow({
    where: { id: shoppingListId, householdId },
    include: { items: { include: { canonicalItem: true } } },
  });

  const canonicalIds = list.items.map((i) => i.canonicalItemId);
  const now = new Date();

  const providers = await prisma.provider.findMany({
    where: { householdId },
    include: {
      products: {
        where: { canonicalItemId: { in: canonicalIds } },
        include: {
          prices: {
            where: {
              validFrom: { lte: now },
              OR: [{ validTo: null }, { validTo: { gte: now } }],
            },
            orderBy: { observedAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  });

  const itemToCanonical = new Map<string, string>();
  for (const item of list.items) itemToCanonical.set(item.id, item.canonicalItemId);

  const optProviders: OptimizerProvider[] = providers.map((p) => {
    const itemCosts: OptimizerProvider['itemCosts'] = {};
    for (const item of list.items) {
      const product = p.products.find((pp) => pp.canonicalItemId === item.canonicalItemId);
      const price = product?.prices[0];
      if (!product || !price) continue;

      const packBase = product.baseQuantity ? Number(product.baseQuantity) : 0;
      const needed = Number(item.baseQuantityNeeded);
      const units = packBase > 0 ? Math.ceil(needed / packBase) : 1;
      // Deal price is already stored in `price.price`; multi-buy is applied as an effective
      // unit price. A richer deal model (thresholds, loyalty) is Phase 2.
      let unitPrice = Number(price.price);
      if (price.multiBuyQty && price.multiBuyPrice && price.multiBuyQty > 0) {
        unitPrice = Math.min(unitPrice, Number(price.multiBuyPrice) / price.multiBuyQty);
      }
      itemCosts[item.id] = { productId: product.id, cost: units * unitPrice };
    }
    return {
      providerId: p.id,
      name: p.name,
      travelMinutes: p.travelMinutes ?? 0,
      itemCosts,
    };
  });

  const input: OptimizerInput = {
    items: list.items.map((i) => ({
      itemId: i.id,
      name: i.canonicalItem.name,
      baseQuantityNeeded: Number(i.baseQuantityNeeded),
      unit: i.unit,
    })),
    providers: optProviders,
    timeValuePerMinute,
    maxStores,
  };

  return { input, itemToCanonical };
}
