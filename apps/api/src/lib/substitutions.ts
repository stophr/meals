import { prisma } from '@meals/db';

// Tenant-scoped ingredient substitutions. An org-global rule (recipeId null) — e.g. always use
// Avocado Oil for Olive Oil — is remembered until reverted/changed. A recipe-scoped rule
// overrides the global one for that recipe. Applied to coverage, costing, list-building, and
// recipe display so a swap flows all the way through planning and shopping.

export interface SubTarget {
  subId: string;
  fromName: string; // original ingredient (for the "substituted from X" badge)
  toId: string;
  toName: string;
  gramsPerMl: unknown;
  gramsPerEach: unknown;
  assumeStocked: boolean;
}

/** Map of fromCanonicalItemId -> substitute, with recipe-scoped rules overriding global. */
export async function subMap(
  householdId: string,
  recipeId?: string,
): Promise<Map<string, SubTarget>> {
  const rows = await prisma.ingredientSubstitution.findMany({
    where: { householdId, OR: [{ recipeId: null }, ...(recipeId ? [{ recipeId }] : [])] },
    include: {
      fromItem: { select: { name: true } },
      toItem: { select: { name: true, gramsPerMl: true, gramsPerEach: true, assumeStocked: true } },
    },
  });
  // Apply global first, then recipe-scoped so the latter wins for the same source item.
  rows.sort((a, b) => (a.recipeId ? 1 : 0) - (b.recipeId ? 1 : 0));
  const m = new Map<string, SubTarget>();
  for (const s of rows) {
    m.set(s.fromCanonicalItemId, {
      subId: s.id,
      fromName: s.fromItem.name,
      toId: s.toCanonicalItemId,
      toName: s.toItem.name,
      gramsPerMl: s.toItem.gramsPerMl,
      gramsPerEach: s.toItem.gramsPerEach,
      assumeStocked: s.toItem.assumeStocked,
    });
  }
  return m;
}

type SubbableIngredient = {
  canonicalItemId: string | null;
  canonicalItem?: {
    name?: string;
    assumeStocked?: boolean;
    gramsPerMl?: unknown;
    gramsPerEach?: unknown;
  } | null;
  substitutedFrom?: string; // original item name (for the badge)
  substitutionId?: string; // the rule's id (for revert)
  originalCanonicalItemId?: string; // the pre-substitution item id
};

/**
 * Rewrite an ingredient list through the substitution map: same amount, swapped item. Keeps
 * quantity/unit/baseQuantity (a swap of oil-for-oil uses the same volume) but repoints the
 * canonical item (and its density/stock facts) to the substitute.
 */
export function applySubs<T extends SubbableIngredient>(ingredients: T[], subs: Map<string, SubTarget>): T[] {
  if (!subs.size) return ingredients;
  return ingredients.map((ing) => {
    const s = ing.canonicalItemId ? subs.get(ing.canonicalItemId) : undefined;
    if (!s) return ing;
    return {
      ...ing,
      canonicalItemId: s.toId,
      canonicalItem: {
        ...(ing.canonicalItem ?? {}),
        name: s.toName,
        assumeStocked: s.assumeStocked,
        gramsPerMl: s.gramsPerMl,
        gramsPerEach: s.gramsPerEach,
      },
      substitutedFrom: s.fromName,
      substitutionId: s.subId,
      originalCanonicalItemId: ing.canonicalItemId!,
    };
  });
}
