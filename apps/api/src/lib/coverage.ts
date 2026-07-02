import type { RecipeCoverage } from '@meals/shared';

// "Cook from pantry" math: for each recipe, check which linked ingredients the current
// inventory fully covers. Free-text (unlinked) ingredients can't be verified — surfaced as
// unlinkedCount so the UI can show "N unverified" instead of pretending.

interface CoverageIngredient {
  canonicalItemId: string | null;
  baseQuantity: unknown; // Prisma Decimal | null
  optional: boolean;
  freeText?: string | null;
  canonicalItem?: { name: string } | null;
}

export function recipeCoverage(
  ingredients: CoverageIngredient[],
  pantry: Map<string, number>,
): RecipeCoverage {
  // Aggregate needs per item first (a recipe may use the same item twice).
  const needs = new Map<string, { name: string; needed: number }>();
  let unlinkedCount = 0;

  for (const ing of ingredients) {
    if (ing.optional) continue;
    if (!ing.canonicalItemId || ing.baseQuantity == null) {
      unlinkedCount++;
      continue;
    }
    const prev = needs.get(ing.canonicalItemId);
    const add = Number(ing.baseQuantity);
    if (prev) prev.needed += add;
    else needs.set(ing.canonicalItemId, { name: ing.canonicalItem?.name ?? 'item', needed: add });
  }

  const missing: RecipeCoverage['missing'] = [];
  const satisfiedItemIds: string[] = [];
  for (const [itemId, n] of needs) {
    const have = pantry.get(itemId) ?? 0;
    if (have >= n.needed) satisfiedItemIds.push(itemId);
    else missing.push({ name: n.name, neededBase: n.needed, haveBase: have });
  }

  return {
    requiredCount: needs.size,
    satisfiedCount: satisfiedItemIds.length,
    missing,
    unlinkedCount,
    cookable: needs.size > 0 && missing.length === 0,
    satisfiedItemIds,
  };
}
