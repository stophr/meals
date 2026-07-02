import type { RecipeCoverage, UnitDimension } from '@meals/shared';
import { dimensionOf } from '@meals/core';
import type { Unit } from '@meals/db';

// "Cook from pantry" math: for each recipe, check which linked ingredients the current
// inventory fully covers. Free-text (unlinked) ingredients can't be verified — surfaced as
// unlinkedCount so the UI can show "N unverified" instead of pretending.
//
// DIMENSION-AWARE: a need measured by weight is only covered by weight stock, etc. Stocking
// "50 each Sugar" never covers a recipe's "300 g sugar" — different measurement types.

interface CoverageIngredient {
  canonicalItemId: string | null;
  baseQuantity: unknown; // Prisma Decimal | null
  unit?: Unit | null;
  optional: boolean;
  freeText?: string | null;
  canonicalItem?: { name?: string; assumeStocked?: boolean } | null;
}

function ingredientDimension(unit: Unit | null | undefined): UnitDimension {
  return unit ? dimensionOf(unit) : 'COUNT'; // bare counts ("3 eggs") are COUNT
}

export function recipeCoverage(
  ingredients: CoverageIngredient[],
  pantry: Map<string, Map<UnitDimension, number>>,
): RecipeCoverage {
  // Aggregate needs per (item, dimension) — a recipe may use the same item twice.
  const needs = new Map<string, { itemId: string; name: string; dim: UnitDimension; needed: number }>();
  const alwaysStocked: string[] = []; // water/ice — assumed on hand, never "missing"
  let unlinkedCount = 0;

  for (const ing of ingredients) {
    if (ing.optional) continue;
    if (ing.canonicalItemId && ing.canonicalItem?.assumeStocked) {
      alwaysStocked.push(ing.canonicalItemId);
      continue;
    }
    if (!ing.canonicalItemId || ing.baseQuantity == null) {
      unlinkedCount++;
      continue;
    }
    const dim = ingredientDimension(ing.unit);
    const key = `${ing.canonicalItemId}:${dim}`;
    const prev = needs.get(key);
    const add = Number(ing.baseQuantity);
    if (prev) prev.needed += add;
    else
      needs.set(key, {
        itemId: ing.canonicalItemId,
        name: ing.canonicalItem?.name ?? 'item',
        dim,
        needed: add,
      });
  }

  const missing: RecipeCoverage['missing'] = [];
  const satisfiedItemIds: string[] = [];
  for (const n of needs.values()) {
    const have = pantry.get(n.itemId)?.get(n.dim) ?? 0;
    if (have >= n.needed) satisfiedItemIds.push(n.itemId);
    else missing.push({ name: n.name, neededBase: n.needed, haveBase: have });
  }

  return {
    requiredCount: needs.size,
    satisfiedCount: satisfiedItemIds.length,
    missing,
    unlinkedCount,
    cookable: needs.size > 0 && missing.length === 0,
    // Always-stocked staples are excluded from the required count but reported as satisfied
    // so cook-tonight costing doesn't try to buy them.
    satisfiedItemIds: [...satisfiedItemIds, ...alwaysStocked],
  };
}
