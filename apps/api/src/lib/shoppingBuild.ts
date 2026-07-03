import { prisma, Unit } from '@meals/db';
import type { Prisma } from '@meals/db';
import { dimensionOf } from '@meals/core';
import { BASE_UNIT, reconcile } from '@meals/shared';
import type { UnitDimension } from '@meals/shared';
import { pantryLots } from './inventory.js';
import { subMap, applySubs } from './substitutions.js';

// Shared shopping-list builder: aggregate ingredients across meal entries (scaled by
// servings), subtract pantry stock, materialize a ShoppingList. Used by both the legacy
// per-plan generate-list route and the queue's "going shopping" flow.

export type EntryForBuild = Prisma.MealPlanEntryGetPayload<{
  include: {
    recipe: { include: { ingredients: { include: { canonicalItem: true } } } };
  };
}>;

export interface BuildOptions {
  name: string;
  mealPlanId?: string;
  coverageStart?: Date;
  coverageEnd?: Date;
}

export async function buildShoppingList(
  householdId: string,
  entries: EntryForBuild[],
  opts: BuildOptions,
) {
  // Aggregate needs per (canonical item, measurement dimension). The base quantity was
  // computed from the RECIPE's unit, so the dimension must be that unit's — never the item's
  // nominal baseUnit — or grams-of-need would be compared against millilitres.
  const needed = new Map<
    string,
    { itemId: string; base: number; dim: UnitDimension; unit: Unit; gramsPerMl: number | null; gramsPerEach: number | null }
  >();
  const subs = await subMap(householdId); // org-global substitutions
  for (const entry of entries) {
    const servings = entry.recipe.servings || 1;
    const ratio = entry.servingsPlanned / servings;
    for (const ing of applySubs(entry.recipe.ingredients, subs)) {
      if (!ing.canonicalItemId || ing.baseQuantity == null || ing.optional) continue;
      if (ing.canonicalItem?.assumeStocked) continue; // water/ice — assumed on hand
      const dim = ing.unit ? dimensionOf(ing.unit) : 'COUNT';
      const key = `${ing.canonicalItemId}:${dim}`;
      const add = Number(ing.baseQuantity) * ratio;
      const prev = needed.get(key);
      if (prev) prev.base += add;
      else
        needed.set(key, {
          itemId: ing.canonicalItemId,
          base: add,
          dim,
          unit: BASE_UNIT[dim],
          gramsPerMl: ing.canonicalItem?.gramsPerMl != null ? Number(ing.canonicalItem.gramsPerMl) : null,
          gramsPerEach: ing.canonicalItem?.gramsPerEach != null ? Number(ing.canonicalItem.gramsPerEach) : null,
        });
    }
  }

  // Subtract pantry stock, bridging weight<->volume via the item's density when known.
  const pantry = await pantryLots(householdId);
  const items = [...needed.values()]
    .map((v) => {
      const { shortfallBase } = reconcile(v.base, v.dim, pantry.get(v.itemId) ?? [], {
        gramsPerMl: v.gramsPerMl,
        gramsPerEach: v.gramsPerEach,
      });
      return { ...v, base: shortfallBase };
    })
    .filter((v) => v.base > 0.0001);

  return prisma.shoppingList.create({
    data: {
      householdId,
      mealPlanId: opts.mealPlanId,
      name: opts.name,
      coverageStart: opts.coverageStart,
      coverageEnd: opts.coverageEnd,
      items: {
        create: items.map((v) => ({
          canonicalItemId: v.itemId,
          quantityNeeded: v.base.toString(),
          unit: v.unit,
          baseQuantityNeeded: v.base.toString(),
        })),
      },
    },
    include: { items: { include: { canonicalItem: true } } },
  });
}
