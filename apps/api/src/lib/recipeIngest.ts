import { prisma } from '@meals/db';
import type { Recipe } from '@meals/db';
import {
  parseIngredientLine,
  complexityOf,
  matchLine,
  toBaseQuantity,
  ingredientKey,
} from '@meals/core';
import type { NormalizedRecipe } from '@meals/ingestion';

const normAlias = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

// Turn a NormalizedRecipe (from JSON-LD import or TheMealDB discovery) into DB rows:
// parse each free-text ingredient line, auto-link to canonical items where the fuzzy match
// is confident, and keep the original line as freeText either way.

export async function ingestRecipe(
  normalized: NormalizedRecipe,
  householdId: string,
): Promise<{ recipe: Recipe; duplicate: boolean }> {
  // Dedup: same external id or same source URL in this household.
  const existing = await prisma.recipe.findFirst({
    where: {
      householdId,
      OR: [
        ...(normalized.externalId ? [{ externalId: normalized.externalId }] : []),
        ...(normalized.sourceUrl ? [{ sourceUrl: normalized.sourceUrl }] : []),
      ],
    },
  });
  if (existing) return { recipe: existing, duplicate: true };

  const items = await prisma.canonicalItem.findMany({ where: { householdId } });
  const candidates = items.map((i) => ({
    productId: i.id, // matcher field name; holds the canonical item id here
    text: `${i.brand ?? ''} ${i.name}`.trim(),
  }));
  // Alias index: an exact/root alias hit is more reliable than fuzzy matching and keeps
  // imports resolving to consolidated roots instead of re-introducing variants.
  const aliasRows = await prisma.ingredientAlias.findMany({
    where: { householdId },
    select: { rawName: true, canonicalItemId: true },
  });
  const aliasMap = new Map(aliasRows.map((a) => [a.rawName, a.canonicalItemId]));

  const parsed = normalized.ingredientLines.map((line) => {
    const p = parseIngredientLine(line);
    // 1) alias by the parsed name or its deterministic root; 2) fall back to fuzzy match.
    const aliasHit = aliasMap.get(normAlias(p.name)) ?? aliasMap.get(ingredientKey(p.name));
    const match = !aliasHit && candidates.length ? matchLine(p.name, candidates) : null;
    const canonicalItemId = aliasHit ?? (match?.decision === 'auto' ? match.productId : null);

    const quantity = p.quantity ?? 1;
    const unit = p.unit ?? 'EACH';
    return {
      canonicalItemId,
      freeText: line,
      quantity: quantity.toString(),
      unit,
      baseQuantity: toBaseQuantity(quantity, unit).baseQuantity.toString(),
      optional: p.optional,
    };
  });

  const recipe = await prisma.recipe.create({
    data: {
      householdId,
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
      ingredients: { create: parsed },
    },
  });

  return { recipe, duplicate: false };
}
