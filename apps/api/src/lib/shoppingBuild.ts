import { prisma, Unit } from '@meals/db';
import type { Prisma } from '@meals/db';

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
  // canonicalItemId -> needed base quantity
  const needed = new Map<string, { base: number; unit: Unit }>();
  for (const entry of entries) {
    const servings = entry.recipe.servings || 1;
    const ratio = entry.servingsPlanned / servings;
    for (const ing of entry.recipe.ingredients) {
      if (!ing.canonicalItemId || ing.baseQuantity == null || ing.optional) continue;
      const add = Number(ing.baseQuantity) * ratio;
      const prev = needed.get(ing.canonicalItemId);
      const unit = ing.canonicalItem?.baseUnit ?? ing.unit;
      if (prev) prev.base += add;
      else needed.set(ing.canonicalItemId, { base: add, unit });
    }
  }

  // Subtract what the pantry already has.
  const inventory = await prisma.inventoryLot.groupBy({
    by: ['canonicalItemId'],
    where: { householdId, canonicalItemId: { in: [...needed.keys()] } },
    _sum: { baseQuantity: true },
  });
  for (const row of inventory) {
    const entry = needed.get(row.canonicalItemId);
    if (entry && row._sum.baseQuantity) entry.base -= Number(row._sum.baseQuantity);
  }

  const items = [...needed.entries()].filter(([, v]) => v.base > 0.0001);

  return prisma.shoppingList.create({
    data: {
      householdId,
      mealPlanId: opts.mealPlanId,
      name: opts.name,
      coverageStart: opts.coverageStart,
      coverageEnd: opts.coverageEnd,
      items: {
        create: items.map(([canonicalItemId, v]) => ({
          canonicalItemId,
          quantityNeeded: v.base.toString(),
          unit: v.unit,
          baseQuantityNeeded: v.base.toString(),
        })),
      },
    },
    include: { items: { include: { canonicalItem: true } } },
  });
}
