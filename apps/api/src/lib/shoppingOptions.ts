import { prisma } from '@meals/db';
import type { Unit } from '@meals/db';
import { dimensionOf } from '@meals/core';
import { crossConvert } from '@meals/shared';

// Per-item provider options for a shopping list: every store × size-variant that has a
// current price, with unit price (per base unit) and pack-adjusted total for the needed
// quantity. Powers the "best unit price vs best total" selection and the per-store Build.

export interface ItemOption {
  providerId: string;
  providerName: string;
  productId: string;
  brand: string | null;
  size: string | null;
  price: number; // per pack
  unitPrice: number | null; // per base unit (g/ml/each) — null when pack size unknown
  packsNeeded: number;
  totalCost: number; // packsNeeded * price
}

export interface ItemWithOptions {
  itemId: string;
  canonicalItemId: string;
  name: string;
  neededBase: number;
  unit: string;
  chosenProductId: string | null;
  chosenProviderId: string | null;
  options: ItemOption[];
}

export async function computeItemOptions(
  householdId: string,
  listId: string,
): Promise<ItemWithOptions[]> {
  const list = await prisma.shoppingList.findFirstOrThrow({
    where: { id: listId, householdId },
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
            where: { validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gte: now } }] },
            orderBy: { observedAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  });

  return list.items.map((item) => {
    const needed = Number(item.baseQuantityNeeded);
    const needDim = dimensionOf(item.unit as Unit);
    const factors = {
      gramsPerMl: item.canonicalItem.gramsPerMl != null ? Number(item.canonicalItem.gramsPerMl) : null,
      gramsPerEach: item.canonicalItem.gramsPerEach != null ? Number(item.canonicalItem.gramsPerEach) : null,
    };
    const options: ItemOption[] = [];
    for (const provider of providers) {
      for (const product of provider.products) {
        if (product.canonicalItemId !== item.canonicalItemId) continue;
        const price = product.prices[0];
        if (!price) continue;
        // Express the pack in the NEED's dimension (bridging weight<->volume via density) so
        // packs-needed and unit price are always comparable, even across mixed-unit products.
        const packRaw = product.baseQuantity ? Number(product.baseQuantity) : 0;
        const packDim = product.packUnit ? dimensionOf(product.packUnit as Unit) : needDim;
        const packBase = packRaw > 0 ? crossConvert(packRaw, packDim, needDim, factors) : null;
        const packsNeeded = packBase && packBase > 0 ? Math.max(1, Math.ceil(needed / packBase)) : 1;
        const unitPrice = packBase && packBase > 0 ? Number(price.price) / packBase : null;
        options.push({
          providerId: provider.id,
          providerName: provider.name,
          productId: product.id,
          brand: product.brand,
          size: product.sizeText,
          price: Number(price.price),
          unitPrice,
          packsNeeded,
          totalCost: Math.round(packsNeeded * Number(price.price) * 100) / 100,
        });
      }
    }
    options.sort((a, b) => a.totalCost - b.totalCost);
    return {
      itemId: item.id,
      canonicalItemId: item.canonicalItemId,
      name: item.canonicalItem.name,
      neededBase: needed,
      unit: item.unit,
      chosenProductId: item.chosenProductId,
      chosenProviderId: item.assignedProviderId,
      options,
    };
  });
}

/** Pick the best option per item by mode; returns {itemId, option} choices (unpriced omitted). */
export function pickBest(
  items: ItemWithOptions[],
  mode: 'unit' | 'total',
): { itemId: string; option: ItemOption }[] {
  const out: { itemId: string; option: ItemOption }[] = [];
  for (const item of items) {
    if (!item.options.length) continue;
    let best = item.options[0]!;
    for (const o of item.options) {
      if (mode === 'unit') {
        // Fall back to total when a unit price is unknown so it still ranks.
        const a = o.unitPrice ?? o.totalCost;
        const b = best.unitPrice ?? best.totalCost;
        if (a < b) best = o;
      } else if (o.totalCost < best.totalCost) {
        best = o;
      }
    }
    out.push({ itemId: item.itemId, option: best });
  }
  return out;
}
