import type { RecipeCoverage, UnitDimension, DimensionedAmount } from '@meals/shared';
import { reconcile } from '@meals/shared';
import { dimensionOf } from '@meals/core';
import type { Unit } from '@meals/db';

// "Cook from pantry" math: for each recipe, check which linked ingredients the current
// inventory covers. Cross-dimension needs are bridged by the item's density when available
// ("2 cups sugar" covered by a "5 lb" bag); otherwise weight/volume never cross-net.

interface CoverageItemFacts {
  name?: string;
  assumeStocked?: boolean;
  gramsPerMl?: unknown;
  gramsPerEach?: unknown;
}
interface CoverageIngredient {
  canonicalItemId: string | null;
  baseQuantity: unknown; // Prisma Decimal | null
  unit?: Unit | null;
  optional: boolean;
  freeText?: string | null;
  canonicalItem?: CoverageItemFacts | null;
}

function ingredientDimension(unit: Unit | null | undefined): UnitDimension {
  return unit ? dimensionOf(unit) : 'COUNT'; // bare counts ("3 eggs") are COUNT
}

export function recipeCoverage(
  ingredients: CoverageIngredient[],
  pantry: Map<string, DimensionedAmount[]>,
): RecipeCoverage {
  // Aggregate needs per (item, dimension) — a recipe may use the same item twice.
  const needs = new Map<
    string,
    { itemId: string; name: string; dim: UnitDimension; needed: number; facts: CoverageItemFacts }
  >();
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
        facts: ing.canonicalItem ?? {},
      });
  }

  const missing: RecipeCoverage['missing'] = [];
  const satisfiedItemIds: string[] = [];
  for (const n of needs.values()) {
    const lots = pantry.get(n.itemId) ?? [];
    const f = {
      gramsPerMl: n.facts.gramsPerMl != null ? Number(n.facts.gramsPerMl) : null,
      gramsPerEach: n.facts.gramsPerEach != null ? Number(n.facts.gramsPerEach) : null,
    };
    const { covered, shortfallBase } = reconcile(n.needed, n.dim, lots, f);
    if (covered) satisfiedItemIds.push(n.itemId);
    else missing.push({ name: n.name, neededBase: n.needed, haveBase: n.needed - shortfallBase });
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
