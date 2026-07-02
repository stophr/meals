import { prisma } from '@meals/db';
import { dimensionOf } from '@meals/core';
import { crossConvert } from '@meals/shared';
import type { Unit } from '@meals/db';

// Recipe costing from real store prices.
//
// Proportional model: an ingredient costs (amount used ÷ pack size) × pack price — the
// honest per-meal number (leftovers get used in later meals). When the recipe unit and the
// product pack are in different dimensions (e.g. "2 cups flour" vs a 2 kg bag) proportional
// math needs density we don't have, so we fall back to counting ONE pack (an upper bound)
// and let costCoverage tell the truth about precision.

export interface ItemPrice {
  price: number; // effective (promo-aware) pack price
  packBase: number | null; // pack size in base units, when known
  packDim: ReturnType<typeof dimensionOf> | null;
  isDeal: boolean;
  gramsPerMl: number | null; // density bridge factors (from the canonical item)
  gramsPerEach: number | null;
}

/**
 * Best price per canonical item across a household's store products. Items usually have
 * several SIZE VARIANTS synced; for costing we take the cheapest per-base-unit variant
 * (bulk sizes — the proportional model assumes leftovers get used in later meals).
 */
export async function loadItemPrices(householdId: string): Promise<Map<string, ItemPrice>> {
  const rows = await prisma.$queryRaw<
    {
      canonicalItemId: string;
      price: string;
      isDeal: boolean;
      baseQuantity: string | null;
      packUnit: string | null;
      gramsPerMl: string | null;
      gramsPerEach: string | null;
    }[]
  >`
    SELECT DISTINCT ON (po."providerProductId")
      pp."canonicalItemId", po.price::text, po."isDeal", pp."baseQuantity"::text, pp."packUnit",
      ci."gramsPerMl"::text, ci."gramsPerEach"::text
    FROM "PriceObservation" po
    JOIN "ProviderProduct" pp ON pp.id = po."providerProductId"
    JOIN "Provider" p ON p.id = pp."providerId"
    JOIN "CanonicalItem" ci ON ci.id = pp."canonicalItemId"
    WHERE p."householdId" = ${householdId}
      AND pp."canonicalItemId" IS NOT NULL
      AND po."validFrom" <= now()
      AND (po."validTo" IS NULL OR po."validTo" >= now())
    ORDER BY po."providerProductId", po."observedAt" DESC`;

  const map = new Map<string, ItemPrice>();
  for (const r of rows) {
    const candidate: ItemPrice = {
      price: Number(r.price),
      packBase: r.baseQuantity ? Number(r.baseQuantity) : null,
      packDim: r.packUnit ? dimensionOf(r.packUnit as Unit) : null,
      isDeal: r.isDeal,
      gramsPerMl: r.gramsPerMl ? Number(r.gramsPerMl) : null,
      gramsPerEach: r.gramsPerEach ? Number(r.gramsPerEach) : null,
    };
    const existing = map.get(r.canonicalItemId);
    if (!existing) {
      map.set(r.canonicalItemId, candidate);
      continue;
    }
    // Prefer the variant with the lowest per-base-unit price; sized beats unsized.
    const unit = (p: ItemPrice) => (p.packBase && p.packBase > 0 ? p.price / p.packBase : null);
    const cu = unit(candidate);
    const eu = unit(existing);
    if ((cu != null && eu == null) || (cu != null && eu != null && cu < eu)) {
      map.set(r.canonicalItemId, candidate);
    } else if (cu == null && eu == null && candidate.price < existing.price) {
      map.set(r.canonicalItemId, candidate);
    }
  }
  return map;
}

export interface RecipeCostResult {
  total: number;
  perServing: number;
  coverage: number; // priced required ingredients / required ingredients
  promoCount: number;
}

export interface CostIngredient {
  canonicalItemId: string | null;
  baseQuantity: unknown; // Prisma Decimal | null
  unit: Unit;
  optional: boolean;
}

export function costRecipe(
  ingredients: CostIngredient[],
  servings: number,
  prices: Map<string, ItemPrice>,
): RecipeCostResult | null {
  const required = ingredients.filter((i) => !i.optional);
  if (!required.length) return null;

  let total = 0;
  let priced = 0;
  let promoCount = 0;
  for (const ing of required) {
    if (!ing.canonicalItemId || ing.baseQuantity == null) continue;
    const p = prices.get(ing.canonicalItemId);
    if (!p) continue;

    const needed = Number(ing.baseQuantity);
    const ingDim = dimensionOf(ing.unit);
    // Bridge the pack into the ingredient's dimension via density ("2 cups" priced from a
    // 2 kg bag). Null = no bridge available, so fall back to one whole pack (upper bound).
    const packInIngDim =
      p.packBase && p.packBase > 0 && p.packDim
        ? crossConvert(p.packBase, p.packDim, ingDim, {
            gramsPerMl: p.gramsPerMl,
            gramsPerEach: p.gramsPerEach,
          })
        : null;
    let cost: number;
    if (packInIngDim && packInIngDim > 0) {
      // Proportional share of the pack, but never more than buying whole packs.
      cost = Math.min((needed / packInIngDim) * p.price, Math.ceil(needed / packInIngDim) * p.price);
    } else {
      cost = p.price; // no pack size or no density bridge: one pack, upper bound
    }
    total += cost;
    priced++;
    if (p.isDeal) promoCount++;
  }
  if (priced === 0) return null;

  return {
    total: Math.round(total * 100) / 100,
    perServing: Math.round((total / Math.max(1, servings)) * 100) / 100,
    coverage: priced / required.length,
    promoCount,
  };
}

/** Recompute + persist cost estimates for every recipe in the household. */
export async function recomputeAllRecipeCosts(householdId: string): Promise<{
  costed: number;
  skipped: number;
}> {
  const prices = await loadItemPrices(householdId);
  let costed = 0;
  let skipped = 0;
  let cursor: string | undefined;
  for (;;) {
    const recipes = await prisma.recipe.findMany({
      where: { householdId },
      include: { ingredients: true },
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: 500,
    });
    if (!recipes.length) break;
    cursor = recipes[recipes.length - 1]!.id;

    for (const recipe of recipes) {
      const result = costRecipe(recipe.ingredients, recipe.servings || 1, prices);
      if (!result) {
        skipped++;
        continue;
      }
      await prisma.recipe.update({
        where: { id: recipe.id },
        data: {
          estCostTotal: result.total.toFixed(2),
          estCostPerServing: result.perServing.toFixed(2),
          costCoverage: Math.round(result.coverage * 100) / 100,
          promoIngredients: result.promoCount,
          costUpdatedAt: new Date(),
        },
      });
      costed++;
    }
  }
  return { costed, skipped };
}
