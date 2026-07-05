// Recipe nutrition, computed "per specific container/brand": each ingredient's nutrition comes
// from the exact Product the household has stocked (FIFO lot), falling back to the ingredient's
// reference Product when it isn't in the pantry. Amounts convert recipe base-units → servings
// via the product's serving size, bridging mass<->volume<->count with the item's density.

import { prisma } from '@meals/db';
import { dimensionOf } from '@meals/core';
import { crossConvert } from '@meals/shared';
import type { UnitDimension } from '@meals/shared';

const MACROS = ['calories', 'proteinG', 'carbsG', 'sugarG', 'fiberG', 'fatG', 'satFatG', 'sodiumMg'] as const;
type Macro = (typeof MACROS)[number];

export interface RecipeNutrition {
  perServing: Partial<Record<Macro, number>>;
  total: Partial<Record<Macro, number>>;
  covered: number; // required ingredients with nutrition data
  required: number;
}

export async function recipeNutrition(recipeId: string, householdId: string): Promise<RecipeNutrition | null> {
  const recipe = await prisma.recipe.findUnique({
    where: { id: recipeId },
    select: {
      servings: true,
      ingredients: {
        select: {
          optional: true,
          baseQuantity: true,
          unit: true,
          canonicalItemId: true,
          canonicalItem: {
            select: { gramsPerMl: true, gramsPerEach: true, baseUnit: true, referenceProductId: true },
          },
        },
      },
    },
  });
  if (!recipe) return null;

  const itemIds = recipe.ingredients.map((i) => i.canonicalItemId).filter((x): x is string => !!x);

  // The org's stocked product per ingredient (FIFO: soonest expiry, then most recent buy).
  const lots = await prisma.inventoryLot.findMany({
    where: { householdId, canonicalItemId: { in: itemIds }, productId: { not: null } },
    select: { canonicalItemId: true, productId: true },
    orderBy: [{ expiresAt: 'asc' }, { purchasedAt: 'desc' }],
  });
  const pantryProduct = new Map<string, string>();
  for (const l of lots) if (l.productId && !pantryProduct.has(l.canonicalItemId)) pantryProduct.set(l.canonicalItemId, l.productId);

  const productIds = new Set<string>();
  for (const ing of recipe.ingredients) {
    const cid = ing.canonicalItemId;
    if (!cid) continue;
    const pid = pantryProduct.get(cid) ?? ing.canonicalItem?.referenceProductId ?? null;
    if (pid) productIds.add(pid);
  }
  const products = await prisma.product.findMany({ where: { id: { in: [...productIds] } } });
  const pById = new Map(products.map((p) => [p.id, p]));

  const total: Partial<Record<Macro, number>> = {};
  let covered = 0;
  let required = 0;

  for (const ing of recipe.ingredients) {
    if (ing.optional) continue;
    required++;
    const cid = ing.canonicalItemId;
    if (!cid || ing.baseQuantity == null) continue;
    const pid = pantryProduct.get(cid) ?? ing.canonicalItem?.referenceProductId ?? null;
    const p = pid ? pById.get(pid) : null;
    if (!p || p.servingBaseQuantity == null || !p.nutritionSource) continue;

    const ingDim: UnitDimension = ing.unit
      ? dimensionOf(ing.unit)
      : ing.canonicalItem?.baseUnit
        ? dimensionOf(ing.canonicalItem.baseUnit)
        : 'MASS';
    const servDim: UnitDimension = p.packUnit ? dimensionOf(p.packUnit) : ingDim;
    const f = {
      gramsPerMl: ing.canonicalItem?.gramsPerMl != null ? Number(ing.canonicalItem.gramsPerMl) : null,
      gramsPerEach: ing.canonicalItem?.gramsPerEach != null ? Number(ing.canonicalItem.gramsPerEach) : null,
    };
    const conv = crossConvert(Number(ing.baseQuantity), ingDim, servDim, f);
    if (conv == null) continue;
    const servings = conv / Number(p.servingBaseQuantity);
    if (!isFinite(servings) || servings <= 0) continue;

    for (const m of MACROS) {
      const v = p[m];
      if (v != null) total[m] = (total[m] ?? 0) + Number(v) * servings;
    }
    covered++;
  }

  const servingsN = recipe.servings || 1;
  const round = (v: number) => Math.round(v * 10) / 10;
  const perServing: Partial<Record<Macro, number>> = {};
  const totalOut: Partial<Record<Macro, number>> = {};
  for (const m of MACROS) {
    if (total[m] != null) {
      totalOut[m] = round(total[m]!);
      perServing[m] = round(total[m]! / servingsN);
    }
  }
  return { perServing, total: totalOut, covered, required };
}
