import type { FastifyInstance } from 'fastify';
import { prisma } from '@meals/db';
import type { Prisma } from '@meals/db';
import {
  recipeCreateSchema,
  recipeUpdateSchema,
  recipeQuerySchema,
  recipeImportSchema,
  discoverIngestSchema,
  cookRecipeSchema,
} from '@meals/shared';
import { toBaseQuantity } from '@meals/core';
import { importRecipeFromUrl, searchMeals, getMeal } from '@meals/ingestion';
import { getHousehold } from '../lib/household.js';
import { recipeCoverage } from '../lib/coverage.js';
import { pantryTotals, consumeFromInventory } from '../lib/inventory.js';
import { ingestRecipe } from '../lib/recipeIngest.js';
import {
  loadItemPrices,
  costRecipe,
  type ItemPrice,
  type CostIngredient,
} from '../lib/recipeCost.js';

/** Cost of only the ingredients the pantry does NOT already cover ("cook tonight for $X"). */
function cookTonightCost(
  ingredients: CostIngredient[],
  servings: number,
  satisfied: Set<string>,
  prices: Map<string, ItemPrice>,
): number | null {
  const toBuy = ingredients.filter(
    (i) => !i.canonicalItemId || !satisfied.has(i.canonicalItemId),
  );
  if (!toBuy.some((i) => i.canonicalItemId)) return 0; // everything covered (or unpriceable)
  const res = costRecipe(toBuy, servings, prices);
  return res ? res.total : null;
}

const ingredientInclude = {
  ingredients: { include: { canonicalItem: { select: { name: true } } } },
} satisfies Prisma.RecipeInclude;

export async function recipeRoutes(app: FastifyInstance) {
  // ---- Catalog search: q + facets + sort + pantry coverage ----
  app.get('/recipes', async (req) => {
    const query = recipeQuerySchema.parse(req.query);
    const household = await getHousehold();

    const where: Prisma.RecipeWhereInput = {
      householdId: household.id,
      ...(query.cuisine ? { cuisine: { equals: query.cuisine, mode: 'insensitive' } } : {}),
      ...(query.category ? { category: { equals: query.category, mode: 'insensitive' } } : {}),
      ...(query.tag ? { tags: { has: query.tag } } : {}),
      ...(query.complexity ? { complexity: query.complexity } : {}),
      ...(query.favorite ? { isFavorite: true } : {}),
      // "Cheapest" is only meaningful when most ingredients are priced — otherwise a recipe
      // looks cheap simply because we haven't priced its ingredients yet.
      ...(query.sort === 'cheapest' ? { costCoverage: { gte: 0.6 }, estCostPerServing: { not: null } } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { cuisine: { contains: query.q, mode: 'insensitive' } },
              {
                ingredients: {
                  some: {
                    OR: [
                      { freeText: { contains: query.q, mode: 'insensitive' } },
                      { canonicalItem: { name: { contains: query.q, mode: 'insensitive' } } },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    };

    const orderBy: Prisma.RecipeOrderByWithRelationInput[] =
      query.sort === 'cheapest'
        ? [{ estCostPerServing: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }]
        : query.sort === 'rating'
        ? [{ externalRating: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }]
        : query.sort === 'popular'
          ? [
              { timesCooked: 'desc' },
              { externalRatingCount: { sort: 'desc', nulls: 'last' } },
              { name: 'asc' },
            ]
          : query.sort === 'newest'
            ? [{ createdAt: 'desc' }]
            : query.sort === 'complexity'
              ? [{ complexity: 'asc' }, { name: 'asc' }]
              : [{ name: 'asc' }];

    const [pantry, prices] = await Promise.all([
      pantryTotals(household.id),
      loadItemPrices(household.id),
    ]);
    const withCost = <T extends { ingredients: CostIngredient[]; servings: number }>(r: T) => {
      const coverage = recipeCoverage(r.ingredients as never, pantry);
      return {
        ...r,
        coverage,
        cookTonightCost: cookTonightCost(
          r.ingredients,
          r.servings || 1,
          new Set(coverage.satisfiedItemIds ?? []),
          prices,
        ),
      };
    };

    if (query.cookable) {
      // A recipe can only be fully cookable when every required ingredient is pantry-linked,
      // so restrict candidates in SQL first (coverage math itself runs in JS). The 2000 cap
      // is a safety net; results beyond it are truncated at extreme catalog sizes.
      const all = await prisma.recipe.findMany({
        where: {
          ...where,
          AND: [
            { ingredients: { some: { canonicalItemId: { not: null } } } },
            { ingredients: { none: { canonicalItemId: null, optional: false } } },
          ],
        },
        orderBy,
        include: ingredientInclude,
        take: 2000,
      });
      const cookable = all.map(withCost).filter((r) => r.coverage.cookable);
      return {
        items: cookable.slice(query.skip, query.skip + query.take),
        total: cookable.length,
      };
    }

    const [items, total] = await Promise.all([
      prisma.recipe.findMany({
        where,
        orderBy,
        include: ingredientInclude,
        take: query.take,
        skip: query.skip,
      }),
      prisma.recipe.count({ where }),
    ]);
    return { items: items.map(withCost), total };
  });

  // Facet values for filter UIs. groupBy/unnest so this stays cheap at catalog scale.
  app.get('/recipes/meta', async () => {
    const household = await getHousehold();
    const [cuisineRows, categoryRows, tagRows] = await Promise.all([
      prisma.recipe.groupBy({
        by: ['cuisine'],
        where: { householdId: household.id, cuisine: { not: null } },
        _count: true,
      }),
      prisma.recipe.groupBy({
        by: ['category'],
        where: { householdId: household.id, category: { not: null } },
        _count: true,
        orderBy: { _count: { category: 'desc' } },
        take: 60,
      }),
      prisma.$queryRaw<{ tag: string }[]>`
        SELECT tag FROM (
          SELECT unnest(tags) AS tag, count(*) AS n
          FROM "Recipe" WHERE "householdId" = ${household.id}
          GROUP BY 1 ORDER BY n DESC LIMIT 100
        ) t ORDER BY tag`,
    ]);
    return {
      cuisines: cuisineRows.map((r) => r.cuisine).sort(),
      categories: categoryRows.map((r) => r.category).sort(),
      tags: tagRows.map((r) => r.tag),
    };
  });

  // ---- Backend recipe discovery (TheMealDB) ----
  app.get('/recipes/discover', async (req) => {
    const { q } = req.query as { q?: string };
    if (!q?.trim()) return { results: [] };
    const household = await getHousehold();
    const results = await searchMeals(q.trim());
    const existing = await prisma.recipe.findMany({
      where: { householdId: household.id, externalId: { in: results.map((r) => r.externalId) } },
      select: { externalId: true },
    });
    const imported = new Set(existing.map((e) => e.externalId));
    return {
      results: results.map((r) => ({ ...r, alreadyImported: imported.has(r.externalId) })),
    };
  });

  app.post('/recipes/discover/ingest', async (req, reply) => {
    const { externalId } = discoverIngestSchema.parse(req.body);
    const household = await getHousehold();
    const normalized = await getMeal(externalId);
    const { recipe, duplicate } = await ingestRecipe(normalized, household.id);
    reply.code(duplicate ? 200 : 201);
    return { ...recipe, duplicate };
  });

  // ---- URL import (schema.org JSON-LD — works on most recipe sites, carries star ratings) ----
  app.post('/recipes/import', async (req, reply) => {
    const { url } = recipeImportSchema.parse(req.body);
    const household = await getHousehold();
    let normalized;
    try {
      normalized = await importRecipeFromUrl(url);
    } catch (err) {
      reply.code(422);
      return { message: err instanceof Error ? err.message : 'Import failed' };
    }
    const { recipe, duplicate } = await ingestRecipe(normalized, household.id);
    reply.code(duplicate ? 200 : 201);
    return { ...recipe, duplicate };
  });

  // ---- Favorites & cooking ----
  app.post('/recipes/:id/favorite', async (req) => {
    const { id } = req.params as { id: string };
    const recipe = await prisma.recipe.findUniqueOrThrow({ where: { id } });
    return prisma.recipe.update({ where: { id }, data: { isFavorite: !recipe.isFavorite } });
  });

  // Cook from the pantry: consume linked ingredients FIFO, bump popularity counters.
  app.post('/recipes/:id/cook', async (req) => {
    const { id } = req.params as { id: string };
    const body = cookRecipeSchema.parse(req.body ?? {});
    const household = await getHousehold();
    const recipe = await prisma.recipe.findUniqueOrThrow({
      where: { id },
      include: ingredientInclude,
    });
    const ratio = (body.servings ?? recipe.servings) / (recipe.servings || 1);

    const consumed: { name: string; consumedBase: number }[] = [];
    const shortfalls: { name: string; shortfallBase: number }[] = [];
    for (const ing of recipe.ingredients) {
      if (ing.optional || !ing.canonicalItemId || ing.baseQuantity == null) continue;
      const needed = Number(ing.baseQuantity) * ratio;
      const result = await consumeFromInventory(household.id, ing.canonicalItemId, needed);
      const name = ing.canonicalItem?.name ?? ing.freeText ?? 'item';
      consumed.push({ name, consumedBase: needed - result.shortfallBase });
      if (result.shortfallBase > 0) shortfalls.push({ name, shortfallBase: result.shortfallBase });
    }

    const updated = await prisma.recipe.update({
      where: { id },
      data: { timesCooked: { increment: 1 }, lastCookedAt: new Date() },
    });
    return { recipe: updated, consumed, shortfalls };
  });

  // ---- CRUD (manual entry stays the base path) ----
  app.get('/recipes/:id', async (req) => {
    const { id } = req.params as { id: string };
    const household = await getHousehold();
    const recipe = await prisma.recipe.findUniqueOrThrow({
      where: { id },
      include: { ingredients: { include: { canonicalItem: true } } },
    });
    const [pantry, prices] = await Promise.all([
      pantryTotals(household.id),
      loadItemPrices(household.id),
    ]);
    const coverage = recipeCoverage(recipe.ingredients, pantry);
    return {
      ...recipe,
      coverage,
      cookTonightCost: cookTonightCost(
        recipe.ingredients,
        recipe.servings || 1,
        new Set(coverage.satisfiedItemIds ?? []),
        prices,
      ),
    };
  });

  app.post('/recipes', async (req, reply) => {
    const data = recipeCreateSchema.parse(req.body);
    const household = await getHousehold();
    reply.code(201);
    return prisma.recipe.create({
      data: {
        householdId: household.id,
        name: data.name,
        servings: data.servings,
        instructions: data.instructions,
        sourceUrl: data.sourceUrl,
        prepMinutes: data.prepMinutes,
        ingredients: {
          create: data.ingredients.map((ing) => ({
            canonicalItemId: ing.canonicalItemId,
            freeText: ing.freeText,
            quantity: ing.quantity.toString(),
            unit: ing.unit,
            baseQuantity: toBaseQuantity(ing.quantity, ing.unit).baseQuantity.toString(),
            prepNote: ing.prepNote,
            optional: ing.optional,
          })),
        },
      },
      include: { ingredients: true },
    });
  });

  app.patch('/recipes/:id', async (req) => {
    const { id } = req.params as { id: string };
    const data = recipeUpdateSchema.parse(req.body);
    return prisma.$transaction(async (tx) => {
      if (data.ingredients) {
        await tx.recipeIngredient.deleteMany({ where: { recipeId: id } });
        await tx.recipeIngredient.createMany({
          data: data.ingredients.map((ing) => ({
            recipeId: id,
            canonicalItemId: ing.canonicalItemId,
            freeText: ing.freeText,
            quantity: ing.quantity.toString(),
            unit: ing.unit,
            baseQuantity: toBaseQuantity(ing.quantity, ing.unit).baseQuantity.toString(),
            prepNote: ing.prepNote,
            optional: ing.optional,
          })),
        });
      }
      return tx.recipe.update({
        where: { id },
        data: {
          name: data.name,
          servings: data.servings,
          instructions: data.instructions,
          sourceUrl: data.sourceUrl,
          prepMinutes: data.prepMinutes,
        },
        include: { ingredients: true },
      });
    });
  });

  app.delete('/recipes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.recipe.delete({ where: { id } });
    reply.code(204);
  });
}
