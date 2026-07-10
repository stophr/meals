// Fast, batched per-serving calorie ESTIMATE for many recipes at once — a few queries total,
// independent of recipe count, so it's cheap enough for the suggested shelf + plan generator.
// Global (uses each ingredient's canonical reference product, not household-stocked lots), so
// results are stable and cacheable. Approximate: an ingredient with no reference-product
// nutrition is skipped; a recipe with no usable ingredients returns null (unknown).
import { prisma } from '@meals/db';
import type { Unit, UnitDimension } from '@meals/db';
import { crossConvert } from '@meals/shared';
import { dimensionOf } from '@meals/core';

export async function batchCaloriesPerServing(recipeIds: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const ids = [...new Set(recipeIds)];
  if (!ids.length) return out;

  const recipes = await prisma.recipe.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      servings: true,
      ingredients: {
        select: { canonicalItemId: true, baseQuantity: true, unit: true, optional: true },
      },
    },
  });

  const itemIds = [
    ...new Set(recipes.flatMap((r) => r.ingredients.map((i) => i.canonicalItemId).filter((x): x is string => !!x))),
  ];
  const items = await prisma.canonicalItem.findMany({
    where: { id: { in: itemIds } },
    select: {
      id: true,
      gramsPerMl: true,
      gramsPerEach: true,
      referenceProduct: { select: { calories: true, servingBaseQuantity: true, servingDimension: true } },
    },
  });
  const itemById = new Map(items.map((i) => [i.id, i]));

  for (const r of recipes) {
    let total = 0;
    let any = false;
    for (const ing of r.ingredients) {
      if (ing.optional || !ing.canonicalItemId || ing.baseQuantity == null) continue;
      const it = itemById.get(ing.canonicalItemId);
      const rp = it?.referenceProduct;
      if (!rp || rp.calories == null || rp.servingBaseQuantity == null || !rp.servingDimension) continue;
      const servBase = Number(rp.servingBaseQuantity);
      if (!(servBase > 0)) continue;
      const factors = {
        gramsPerMl: it!.gramsPerMl != null ? Number(it!.gramsPerMl) : null,
        gramsPerEach: it!.gramsPerEach != null ? Number(it!.gramsPerEach) : null,
      };
      const needDim = (ing.unit ? dimensionOf(ing.unit as Unit) : (rp.servingDimension as UnitDimension)) as UnitDimension;
      const inServingDim = crossConvert(Number(ing.baseQuantity), needDim, rp.servingDimension as UnitDimension, factors);
      if (inServingDim == null || !Number.isFinite(inServingDim)) continue;
      total += Number(rp.calories) * (inServingDim / servBase);
      any = true;
    }
    out.set(r.id, any ? Math.round(total / (r.servings || 1)) : null);
  }
  return out;
}

/**
 * Household daily calorie target = sum of members' profile targets (multi-person reconciliation).
 * Null when no member has computed targets yet.
 */
export async function householdCalorieTarget(householdId: string): Promise<number | null> {
  const rows = await prisma.dietProfile.findMany({
    where: { user: { householdId }, targetCalories: { not: null } },
    select: { targetCalories: true },
  });
  if (!rows.length) return null;
  return rows.reduce((s, r) => s + (r.targetCalories ?? 0), 0);
}

/**
 * A recipe "fits a meal" when its per-serving calories land in a sensible single-meal share of the
 * per-person daily target (~20–45%). Returns a 0..1 fit score (1 = right in the sweet spot).
 */
export function mealFitScore(caloriesPerServing: number | null, dailyTargetPerPerson: number | null): number {
  if (caloriesPerServing == null || !dailyTargetPerPerson) return 0;
  const share = caloriesPerServing / dailyTargetPerPerson;
  if (share <= 0) return 0;
  // Peak at ~0.33 of the day; taper to 0 outside [0.15, 0.5].
  const center = 0.33;
  const halfWidth = 0.17;
  const d = Math.abs(share - center);
  return Math.max(0, 1 - d / halfWidth);
}
