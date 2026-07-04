import { prisma } from '@meals/db';
import type { Recipe, Prisma } from '@meals/db';
import {
  parseIngredientLine,
  complexityOf,
  matchLine,
  toBaseQuantity,
  ingredientKey,
} from '@meals/core';
import type { NormalizedRecipe } from '@meals/ingestion';

const normAlias = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

// ---- Ingredient linking context (load once; reuse across many recipes) ----

export interface LinkContext {
  candidates: { productId: string; text: string }[];
  aliasMap: Map<string, string>;
}

export async function loadLinkContext(): Promise<LinkContext> {
  const [items, aliasRows] = await Promise.all([
    prisma.canonicalItem.findMany({ select: { id: true, name: true, brand: true } }),
    prisma.ingredientAlias.findMany({ select: { rawName: true, canonicalItemId: true } }),
  ]);
  return {
    candidates: items.map((i) => ({ productId: i.id, text: `${i.brand ?? ''} ${i.name}`.trim() })),
    aliasMap: new Map(aliasRows.map((a) => [a.rawName, a.canonicalItemId])),
  };
}

/** Parse + link free-text ingredient lines into ingredient rows (alias first, then fuzzy). */
export function buildIngredientRows(
  lines: string[],
  ctx: LinkContext,
): Omit<Prisma.RecipeIngredientCreateManyInput, 'recipeId'>[] {
  return lines.map((line) => {
    const p = parseIngredientLine(line);
    const aliasHit = ctx.aliasMap.get(normAlias(p.name)) ?? ctx.aliasMap.get(ingredientKey(p.name));
    const match = !aliasHit && ctx.candidates.length ? matchLine(p.name, ctx.candidates) : null;
    const canonicalItemId = aliasHit ?? (match?.decision === 'auto' ? match.productId : null);
    const quantity = p.quantity ?? 1;
    const unit = p.unit ?? 'EACH';
    return {
      canonicalItemId,
      freeText: line.slice(0, 500),
      quantity: quantity.toString(),
      unit,
      baseQuantity: toBaseQuantity(quantity, unit).baseQuantity.toString(),
      optional: p.optional,
    };
  });
}

/** foodcom:<id> for a food.com recipe URL, so re-imports match the CSV-imported recipe. */
export function externalIdForUrl(url: string): string | undefined {
  const m = url.match(/food\.com\/recipe\/(?:[a-z0-9-]*-)?(\d+)/i);
  return m ? `foodcom:${m[1]}` : undefined;
}

export interface EnrichTarget {
  id: string;
  servings: number;
  instructions: string | null;
  imageUrl: string | null;
  prepMinutes: number | null;
  cuisine: string | null;
  category: string | null;
}

/**
 * Replace a recipe's ingredients from a fresher source ONLY when it's richer (more lines) — so
 * re-importing a thin Food.com recipe from its live page fills in the missing ingredients
 * without ever regressing a good one. Also refreshes instructions/servings/image/etc.
 */
export async function enrichRecipe(
  recipe: EnrichTarget,
  normalized: NormalizedRecipe,
  ctx: LinkContext,
): Promise<{ enriched: boolean }> {
  const rows = buildIngredientRows(normalized.ingredientLines, ctx);
  const existing = await prisma.recipeIngredient.findMany({
    where: { recipeId: recipe.id },
    select: { unit: true },
  });
  // "Richer" = more ingredient lines OR more lines carrying a real measurement unit (the
  // Food.com dataset is often unitless — "1 1/2 mayonnaise" — while the live page has "cups").
  const withUnit = (u: string) => u !== 'EACH';
  const liveUnits = rows.filter((r) => withUnit(r.unit as string)).length;
  const existingUnits = existing.filter((e) => withUnit(e.unit as string)).length;
  if (rows.length <= existing.length && liveUnits <= existingUnits) return { enriched: false };
  await prisma.$transaction(async (tx) => {
    await tx.recipeIngredient.deleteMany({ where: { recipeId: recipe.id } });
    await tx.recipe.update({
      where: { id: recipe.id },
      data: {
        servings: normalized.servings ?? recipe.servings,
        instructions: normalized.instructions ?? recipe.instructions,
        imageUrl: normalized.imageUrl ?? recipe.imageUrl,
        prepMinutes: normalized.prepMinutes ?? recipe.prepMinutes,
        cuisine: normalized.cuisine ?? recipe.cuisine,
        category: normalized.category ?? recipe.category,
        complexity: complexityOf(normalized.ingredientLines.length, normalized.prepMinutes),
        ingredients: { create: rows },
      },
    });
  });
  return { enriched: true };
}

/**
 * Import a recipe: create it, or — when it already exists (same externalId/sourceUrl) — enrich
 * it in place from the (richer) source instead of duplicating.
 */
export async function ingestRecipe(
  normalized: NormalizedRecipe,
  householdId: string,
): Promise<{ recipe: Recipe; duplicate: boolean; enriched?: boolean }> {
  const existing = await prisma.recipe.findFirst({
    where: {
      householdId,
      OR: [
        ...(normalized.externalId ? [{ externalId: normalized.externalId }] : []),
        ...(normalized.sourceUrl ? [{ sourceUrl: normalized.sourceUrl }] : []),
      ],
    },
  });

  const ctx = await loadLinkContext();

  if (existing) {
    const { enriched } = await enrichRecipe(existing, normalized, ctx);
    const recipe = enriched ? await prisma.recipe.findUniqueOrThrow({ where: { id: existing.id } }) : existing;
    return { recipe, duplicate: !enriched, enriched };
  }

  const recipe = await prisma.recipe.create({
    data: {
      householdId,
      isShared: false, // private to the importing org until explicitly shared
      name: normalized.name,
      servings: normalized.servings ?? 4,
      instructions: normalized.instructions,
      sourceUrl: normalized.sourceUrl,
      sourceName: normalized.sourceName,
      externalId: normalized.externalId,
      imageUrl: normalized.imageUrl,
      prepMinutes: normalized.prepMinutes,
      cuisine: normalized.cuisine,
      category: normalized.category,
      tags: normalized.tags,
      complexity: complexityOf(normalized.ingredientLines.length, normalized.prepMinutes),
      externalRating: normalized.externalRating,
      externalRatingCount: normalized.externalRatingCount,
      ingredients: { create: buildIngredientRows(normalized.ingredientLines, ctx) },
    },
  });

  return { recipe, duplicate: false };
}
