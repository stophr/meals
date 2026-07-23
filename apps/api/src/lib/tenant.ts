// The seam every by-id read/mutation crosses: prove the row belongs to the household before
// touching it. findFirstOrThrow throws P2025, which the app error handler maps to 404 — so a
// cross-tenant id probe is indistinguishable from a missing row. Handlers must never resolve a
// tenant-owned row by bare id; they come through here.
import { prisma } from '@meals/db';
import type {
  BrandPreference,
  IngredientSubstitution,
  InventoryLot,
  KrogerCoupon,
  MealPlan,
  MealPlanEntry,
  MealRule,
  Recipe,
  ShoppingList,
  ShoppingListItem,
} from '@meals/db';

export function owned(householdId: string) {
  return {
    shoppingList: (id: string): Promise<ShoppingList> =>
      prisma.shoppingList.findFirstOrThrow({ where: { id, householdId } }),
    shoppingListItem: (id: string): Promise<ShoppingListItem> =>
      prisma.shoppingListItem.findFirstOrThrow({ where: { id, shoppingList: { householdId } } }),
    inventoryLot: (id: string): Promise<InventoryLot> =>
      prisma.inventoryLot.findFirstOrThrow({ where: { id, householdId } }),
    mealPlan: (id: string): Promise<MealPlan> =>
      prisma.mealPlan.findFirstOrThrow({ where: { id, householdId } }),
    mealPlanEntry: (id: string): Promise<MealPlanEntry> =>
      prisma.mealPlanEntry.findFirstOrThrow({ where: { id, mealPlan: { householdId } } }),
    mealRule: (id: string): Promise<MealRule> =>
      prisma.mealRule.findFirstOrThrow({ where: { id, householdId } }),
    substitution: (id: string): Promise<IngredientSubstitution> =>
      prisma.ingredientSubstitution.findFirstOrThrow({ where: { id, householdId } }),
    coupon: (id: string): Promise<KrogerCoupon> =>
      prisma.krogerCoupon.findFirstOrThrow({ where: { id, householdId } }),
    brandPreference: (id: string): Promise<BrandPreference> =>
      prisma.brandPreference.findFirstOrThrow({ where: { id, householdId } }),
    /** Own recipe — or, with allowShared, any recipe in the global shared directory. */
    recipe: (id: string, opts?: { allowShared?: boolean }): Promise<Recipe> =>
      prisma.recipe.findFirstOrThrow({
        where: opts?.allowShared
          ? { id, OR: [{ householdId }, { isShared: true }] }
          : { id, householdId },
      }),
  };
}
