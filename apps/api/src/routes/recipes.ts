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
import { toBaseQuantity, dimensionOf } from '@meals/core';
import { importRecipeFromUrl, searchMeals, getMeal } from '@meals/ingestion';
import { getHousehold, requireEditor } from '../lib/household.js';
import { owned } from '../lib/tenant.js';
import { getPrincipal } from '../lib/principal.js';
import { batchCaloriesPerServing, mealFitScore } from '../lib/recipeCalories.js';
import { recipeCoverage } from '../lib/coverage.js';
import { pantryLots, consumeFromInventory } from '../lib/inventory.js';
import { subMap, applySubs } from '../lib/substitutions.js';
import { ingestRecipe, externalIdForUrl } from '../lib/recipeIngest.js';
import { recipeNutrition } from '../lib/recipeNutrition.js';
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
  ingredients: {
    include: {
      canonicalItem: {
        select: { name: true, assumeStocked: true, gramsPerMl: true, gramsPerEach: true },
      },
    },
  },
} satisfies Prisma.RecipeInclude;

// Everything needed to decorate a recipe row with the org's pantry coverage, substitutions,
// per-org favorite flag, and cook-tonight cost. Loaded once, reused across a batch of recipes.
interface DecorCtx {
  favIds: Set<string>;
  subs: Awaited<ReturnType<typeof subMap>>;
  pantry: Awaited<ReturnType<typeof pantryLots>>;
  prices: Awaited<ReturnType<typeof loadItemPrices>>;
}

async function loadDecorCtx(householdId: string, recipeId?: string): Promise<DecorCtx> {
  const [pantry, prices, subs, favRows] = await Promise.all([
    pantryLots(householdId),
    loadItemPrices(householdId),
    subMap(householdId, recipeId), // org-global (+ this-recipe) substitutions
    prisma.recipeFavorite.findMany({ where: { householdId }, select: { recipeId: true } }),
  ]);
  return { favIds: new Set(favRows.map((f) => f.recipeId)), subs, pantry, prices };
}

function decorateRecipe<T extends { id: string; ingredients: CostIngredient[]; servings: number }>(
  r: T,
  ctx: DecorCtx,
) {
  const ingredients = applySubs(r.ingredients as never[], ctx.subs) as typeof r.ingredients;
  const coverage = recipeCoverage(ingredients as never, ctx.pantry);
  return {
    ...r,
    isFavorite: ctx.favIds.has(r.id), // per-org
    ingredients,
    coverage,
    cookTonightCost: cookTonightCost(
      ingredients,
      r.servings || 1,
      new Set(coverage.satisfiedItemIds ?? []),
      ctx.prices,
    ),
  };
}

export async function recipeRoutes(app: FastifyInstance) {
  // ---- Catalog search: q + facets + sort + pantry coverage ----
  app.get('/recipes', async (req) => {
    const query = recipeQuerySchema.parse(req.query);
    const household = await getHousehold(req);

    const where: Prisma.RecipeWhereInput = {
      // Visibility: the GLOBAL shared corpus plus this org's own (private) recipes.
      AND: [
        { OR: [{ isShared: true }, { householdId: household.id }] },
        ...(query.q
          ? [
              {
                OR: [
                  { name: { contains: query.q, mode: 'insensitive' as const } },
                  { cuisine: { contains: query.q, mode: 'insensitive' as const } },
                  {
                    ingredients: {
                      some: {
                        OR: [
                          { freeText: { contains: query.q, mode: 'insensitive' as const } },
                          { canonicalItem: { name: { contains: query.q, mode: 'insensitive' as const } } },
                        ],
                      },
                    },
                  },
                ],
              },
            ]
          : []),
      ],
      ...(query.cuisine ? { cuisine: { equals: query.cuisine, mode: 'insensitive' } } : {}),
      ...(query.category ? { category: { equals: query.category, mode: 'insensitive' } } : {}),
      ...(query.tag ? { tags: { has: query.tag } } : {}),
      ...(query.complexity ? { complexity: query.complexity } : {}),
      ...(query.favorite ? { favorites: { some: { householdId: household.id } } } : {}),
      // "Cheapest" is only meaningful when most ingredients are priced — otherwise a recipe
      // looks cheap simply because we haven't priced its ingredients yet.
      ...(query.sort === 'cheapest' ? { costCoverage: { gte: 0.6 }, estCostPerServing: { not: null } } : {}),
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

    const ctx = await loadDecorCtx(household.id);
    const withCost = <T extends { id: string; ingredients: CostIngredient[]; servings: number }>(r: T) =>
      decorateRecipe(r, ctx);

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
  app.get('/recipes/meta', async (req) => {
    const household = await getHousehold(req);
    // Facets span the visible corpus: shared recipes + this org's own.
    const visible = { OR: [{ isShared: true }, { householdId: household.id }] };
    const [cuisineRows, categoryRows, tagRows] = await Promise.all([
      prisma.recipe.groupBy({
        by: ['cuisine'],
        where: { ...visible, cuisine: { not: null } },
        _count: true,
      }),
      prisma.recipe.groupBy({
        by: ['category'],
        where: { ...visible, category: { not: null } },
        _count: true,
        orderBy: { _count: { category: 'desc' } },
        take: 60,
      }),
      prisma.$queryRaw<{ tag: string }[]>`
        SELECT tag FROM (
          SELECT unnest(tags) AS tag, count(*) AS n
          FROM "Recipe" WHERE ("isShared" = true OR "householdId" = ${household.id})
          GROUP BY 1 ORDER BY n DESC LIMIT 100
        ) t ORDER BY tag`,
    ]);
    return {
      cuisines: cuisineRows.map((r) => r.cuisine).sort(),
      categories: categoryRows.map((r) => r.category).sort(),
      tags: tagRows.map((r) => r.tag),
    };
  });

  // ---- "Suggested for you": household-taste recommendations ----
  // Content-based recommender. Learns a taste profile from this org's explicit favorites
  // (strong signal) and previously planned recipes (mild signal) — which cuisines, categories
  // and tags they gravitate to — then scores the visible corpus by affinity + pantry-cookable
  // + rating, excluding what they've already favorited. Cold start (no signal yet) falls back
  // to well-regarded shared recipes. No schema/state of its own; recomputed per request.
  app.get('/recipes/suggested', async (req) => {
    const household = await getHousehold(req);
    const take = Math.min(Math.max(Number((req.query as { take?: string })?.take) || 12, 1), 40);
    // Current user's daily calorie target — recipes that portion well against it get a nudge.
    const principal = await getPrincipal(req);
    const dp = await prisma.dietProfile.findUnique({
      where: { userId: principal.userId },
      select: { targetCalories: true },
    });
    const userTarget = dp?.targetCalories ?? null;
    const fitPct = (cal: number | null) => (cal != null && userTarget ? Math.round((cal / userTarget) * 100) : null);
    const visible: Prisma.RecipeWhereInput = {
      OR: [{ isShared: true }, { householdId: household.id }],
    };

    // Taste signals: favorites weigh 3, previously-planned recipes weigh 1 (per occurrence).
    const [favRows, plannedRows] = await Promise.all([
      prisma.recipeFavorite.findMany({ where: { householdId: household.id }, select: { recipeId: true } }),
      prisma.mealPlanEntry.findMany({
        where: { mealPlan: { householdId: household.id } },
        select: { recipeId: true },
        take: 500,
      }),
    ]);
    const favIds = new Set(favRows.map((f) => f.recipeId));
    const weight = new Map<string, number>(); // recipeId -> taste weight
    for (const f of favRows) weight.set(f.recipeId, (weight.get(f.recipeId) ?? 0) + 3);
    for (const p of plannedRows) weight.set(p.recipeId, (weight.get(p.recipeId) ?? 0) + 1);

    const ctx = await loadDecorCtx(household.id);
    const covFractionOf = (r: { ingredients: CostIngredient[] }) => {
      const cov = recipeCoverage(
        applySubs(r.ingredients as never[], ctx.subs) as never,
        ctx.pantry,
      );
      return {
        frac: cov.requiredCount > 0 ? cov.satisfiedCount / cov.requiredCount : 0,
        cookable: cov.cookable,
      };
    };

    // Cold start: no favorites or planning history yet -> surface well-regarded shared recipes,
    // nudged by whatever the pantry can already cook.
    if (weight.size === 0) {
      const rows = await prisma.recipe.findMany({
        where: { ...visible, isShared: true },
        orderBy: [{ externalRating: { sort: 'desc', nulls: 'last' } }, { timesCooked: 'desc' }],
        include: ingredientInclude,
        take: take * 4,
      });
      const calMap0 = userTarget ? await batchCaloriesPerServing(rows.map((r) => r.id)) : new Map();
      const scored = rows.map((r) => {
        const { frac } = covFractionOf(r);
        return { r, s: (r.externalRating ?? 3) + 2 * frac + 1.2 * mealFitScore(calMap0.get(r.id) ?? null, userTarget) + Math.random() };
      });
      scored.sort((a, b) => b.s - a.s);
      return {
        reason: 'popular',
        items: scored.slice(0, take).map((x) => {
          const cal = calMap0.get(x.r.id) ?? null;
          return { ...decorateRecipe(x.r, ctx), caloriesPerServing: cal, dietFitPct: fitPct(cal) };
        }),
      };
    }

    // Learn cuisine / category / tag affinity from the signal recipes.
    const signalRecipes = await prisma.recipe.findMany({
      where: { id: { in: [...weight.keys()] } },
      select: { id: true, cuisine: true, category: true, tags: true },
    });
    const cuisineW = new Map<string, number>();
    const categoryW = new Map<string, number>();
    const tagW = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string | null, w: number) => {
      if (k) m.set(k, (m.get(k) ?? 0) + w);
    };
    for (const r of signalRecipes) {
      const w = weight.get(r.id) ?? 1;
      bump(cuisineW, r.cuisine, w);
      bump(categoryW, r.category, w);
      for (const t of r.tags) bump(tagW, t, w);
    }
    const top = (m: Map<string, number>, n: number) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[0]);
    const topCuisines = top(cuisineW, 8);
    const topCategories = top(categoryW, 10);
    const topTags = top(tagW, 20);

    // Candidate pool: visible recipes matching any liked facet, minus what's already favorited.
    const orFacets: Prisma.RecipeWhereInput[] = [];
    if (topCuisines.length) orFacets.push({ cuisine: { in: topCuisines } });
    if (topCategories.length) orFacets.push({ category: { in: topCategories } });
    if (topTags.length) orFacets.push({ tags: { hasSome: topTags } });

    const candidates = await prisma.recipe.findMany({
      where: {
        AND: [
          visible,
          { id: { notIn: [...favIds] } },
          ...(orFacets.length ? [{ OR: orFacets }] : []),
        ],
      },
      orderBy: [{ externalRating: { sort: 'desc', nulls: 'last' } }],
      include: ingredientInclude,
      take: 600,
    });

    const calMap = userTarget ? await batchCaloriesPerServing(candidates.map((c) => c.id)) : new Map();
    const scored = candidates.map((r) => {
      const { frac, cookable } = covFractionOf(r);
      const affinity =
        1.5 * (r.cuisine ? cuisineW.get(r.cuisine) ?? 0 : 0) +
        1.0 * (r.category ? categoryW.get(r.category) ?? 0 : 0) +
        0.5 * r.tags.reduce((s, t) => s + (tagW.get(t) ?? 0), 0);
      const conf =
        r.externalRatingCount != null
          ? Math.min(1, Math.log1p(r.externalRatingCount) / Math.log(50))
          : 0.6;
      const s =
        affinity +
        0.3 * (r.externalRating ?? 3) * conf +
        2 * frac +
        (cookable ? 1 : 0) +
        1.2 * mealFitScore(calMap.get(r.id) ?? null, userTarget) + // portions well for your day
        Math.random() * 0.5; // jitter so the shelf refreshes
      return { r, s };
    });
    scored.sort((a, b) => b.s - a.s);
    return {
      reason: 'taste',
      items: scored.slice(0, take).map((x) => {
        const cal = calMap.get(x.r.id) ?? null;
        return { ...decorateRecipe(x.r, ctx), caloriesPerServing: cal, dietFitPct: fitPct(cal) };
      }),
    };
  });

  // ---- Backend recipe discovery (TheMealDB) ----
  app.get('/recipes/discover', async (req) => {
    const { q } = req.query as { q?: string };
    if (!q?.trim()) return { results: [] };
    const household = await getHousehold(req);
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
    const household = await getHousehold(req);
    const normalized = await getMeal(externalId);
    const { recipe, duplicate } = await ingestRecipe(normalized, household.id);
    reply.code(duplicate ? 200 : 201);
    return { ...recipe, duplicate };
  });

  // ---- URL import (schema.org JSON-LD — works on most recipe sites, carries star ratings) ----
  app.post('/recipes/import', async (req, reply) => {
    const { url } = recipeImportSchema.parse(req.body);
    const household = await getHousehold(req);
    let normalized;
    try {
      normalized = await importRecipeFromUrl(url);
    } catch (err) {
      reply.code(422);
      return { message: err instanceof Error ? err.message : 'Import failed' };
    }
    // Tag Food.com URLs with foodcom:<id> so re-imports match the CSV-imported recipe and
    // enrich it in place instead of duplicating.
    normalized.externalId = normalized.externalId ?? externalIdForUrl(url);

    const { recipe, duplicate, enriched } = await ingestRecipe(normalized, household.id);
    if (enriched) {
      // Refresh the stored cost estimate for the recipe we just filled in.
      const full = await prisma.recipe.findUniqueOrThrow({
        where: { id: recipe.id },
        include: { ingredients: true },
      });
      const res = costRecipe(full.ingredients, full.servings || 1, await loadItemPrices(household.id));
      if (res) {
        await prisma.recipe.update({
          where: { id: recipe.id },
          data: {
            estCostTotal: res.total.toFixed(2),
            estCostPerServing: res.perServing.toFixed(2),
            costCoverage: Math.round(res.coverage * 100) / 100,
            promoIngredients: res.promoCount,
            costUpdatedAt: new Date(),
          },
        });
      }
    }
    reply.code(enriched || !duplicate ? 201 : 200);
    return { ...recipe, duplicate, enriched: !!enriched };
  });

  // ---- Favorites (per-org) & cooking ----
  app.post('/recipes/:id/favorite', async (req) => {
    const { id } = req.params as { id: string };
    const household = await getHousehold(req);
    const key = { householdId_recipeId: { householdId: household.id, recipeId: id } };
    const existing = await prisma.recipeFavorite.findUnique({ where: key });
    if (existing) {
      await prisma.recipeFavorite.delete({ where: key });
      return { isFavorite: false };
    }
    await prisma.recipeFavorite.create({ data: { householdId: household.id, recipeId: id } });
    return { isFavorite: true };
  });

  // Share a recipe to the global corpus, or make it private again. Owner org only.
  app.post('/recipes/:id/share', async (req, reply) => {
    const { id } = req.params as { id: string };
    const household = await getHousehold(req);
    const shared = (req.body as { shared?: boolean } | null)?.shared ?? true;
    const recipe = await prisma.recipe.findUniqueOrThrow({ where: { id } });
    if (recipe.householdId !== household.id) {
      reply.code(403);
      return { message: 'Only the org that added a recipe can share it.' };
    }
    return prisma.recipe.update({ where: { id }, data: { isShared: shared } });
  });

  // Cook from the pantry: consume linked ingredients FIFO, bump popularity counters.
  app.post('/recipes/:id/cook', async (req) => {
    const { id } = req.params as { id: string };
    const body = cookRecipeSchema.parse(req.body ?? {});
    const household = await requireEditor(req);
    // Own recipe, or any recipe from the global shared directory (cooking touches only own pantry).
    const recipe = await prisma.recipe.findFirstOrThrow({
      where: { id, OR: [{ householdId: household.id }, { isShared: true }] },
      include: ingredientInclude,
    });
    const ratio = (body.servings ?? recipe.servings) / (recipe.servings || 1);

    const consumed: { name: string; consumedBase: number }[] = [];
    const shortfalls: { name: string; shortfallBase: number }[] = [];
    for (const ing of recipe.ingredients) {
      if (ing.optional || !ing.canonicalItemId || ing.baseQuantity == null) continue;
      const needed = Number(ing.baseQuantity) * ratio;
      const dim = ing.unit ? dimensionOf(ing.unit) : 'COUNT';
      const result = await consumeFromInventory(household.id, ing.canonicalItemId, needed, dim);
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
    const household = await getHousehold(req);
    // Own recipes plus the global shared directory — never another org's private recipe.
    const recipe = await prisma.recipe.findFirstOrThrow({
      where: { id, OR: [{ householdId: household.id }, { isShared: true }] },
      include: { ingredients: { include: { canonicalItem: true } } },
    });
    const [pantry, prices, subs, fav, nutrition] = await Promise.all([
      pantryLots(household.id),
      loadItemPrices(household.id),
      subMap(household.id, id), // global + this-recipe substitutions
      prisma.recipeFavorite.findUnique({
        where: { householdId_recipeId: { householdId: household.id, recipeId: id } },
      }),
      recipeNutrition(id, household.id), // per-org: uses the org's stocked products
    ]);
    const ingredients = applySubs(recipe.ingredients, subs);
    const coverage = recipeCoverage(ingredients, pantry);
    return {
      ...recipe,
      isFavorite: !!fav, // per-org
      canShare: recipe.householdId === household.id, // owner org can toggle sharing
      nutrition,
      ingredients,
      coverage,
      cookTonightCost: cookTonightCost(
        ingredients,
        recipe.servings || 1,
        new Set(coverage.satisfiedItemIds ?? []),
        prices,
      ),
    };
  });

  app.post('/recipes', async (req, reply) => {
    const data = recipeCreateSchema.parse(req.body);
    const household = await getHousehold(req);
    reply.code(201);
    return prisma.recipe.create({
      data: {
        householdId: household.id,
        isShared: false, // private to the org until explicitly shared
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
    const household = await requireEditor(req);
    await owned(household.id).recipe(id);
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
    const household = await requireEditor(req);
    await owned(household.id).recipe(id);
    await prisma.recipe.delete({ where: { id } });
    reply.code(204);
  });
}
