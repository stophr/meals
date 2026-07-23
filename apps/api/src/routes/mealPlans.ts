import type { FastifyInstance } from 'fastify';
import { prisma, Unit } from '@meals/db';
import type { Recipe, RecipeIngredient } from '@meals/db';
import {
  mealPlanCreateSchema,
  mealPlanEntryCreateSchema,
  generateMealPlanSchema,
  stageRecipeSchema,
  assignEntrySchema,
  moveEntrySchema,
  mealRuleCreateSchema,
} from '@meals/shared';
import { getHousehold, requireEditor } from '../lib/household.js';
import { owned } from '../lib/tenant.js';
import { pantryLots } from '../lib/inventory.js';
import { batchCaloriesPerServing, mealFitScore } from '../lib/recipeCalories.js';
import { recipeCoverage } from '../lib/coverage.js';
import { materializeRules, activeRules } from '../lib/mealRules.js';
import { lockedDays, dayKey } from '../lib/queue.js';
import { buildShoppingList } from '../lib/shoppingBuild.js';

const DAY_MS = 86_400_000;

/** Latest plan still covering today, or a fresh 4-week plan to stage into. */
async function currentPlan(householdId: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const existing = await prisma.mealPlan.findFirst({
    where: { householdId, endDate: { gte: today } },
    orderBy: { startDate: 'desc' },
  });
  if (existing) return existing;
  return prisma.mealPlan.create({
    data: {
      householdId,
      name: `Plan from ${today.toISOString().slice(0, 10)}`,
      startDate: today,
      endDate: new Date(today.getTime() + 27 * DAY_MS),
    },
  });
}

export async function mealPlanRoutes(app: FastifyInstance) {
  app.get('/meal-plans', async (req) => {
    const household = await getHousehold(req);
    return prisma.mealPlan.findMany({
      where: { householdId: household.id },
      include: { entries: { include: { recipe: true } } },
      orderBy: { startDate: 'desc' },
    });
  });

  app.get('/meal-plans/:id', async (req) => {
    const { id } = req.params as { id: string };
    const household = await getHousehold(req);
    return prisma.mealPlan.findFirstOrThrow({
      where: { id, householdId: household.id },
      include: { entries: { include: { recipe: true } }, shoppingLists: true },
    });
  });

  app.post('/meal-plans', async (req, reply) => {
    const data = mealPlanCreateSchema.parse(req.body);
    const household = await getHousehold(req);
    reply.code(201);
    return prisma.mealPlan.create({
      data: { householdId: household.id, name: data.name, startDate: data.startDate, endDate: data.endDate },
    });
  });

  app.post('/meal-plans/:id/entries', async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = mealPlanEntryCreateSchema.parse(req.body);
    const household = await requireEditor(req);
    await owned(household.id).mealPlan(id);
    if (data.date) {
      const locks = await lockedDays(household.id);
      if (locks.has(dayKey(data.date))) {
        reply.code(409);
        return { message: 'That day is locked — a shopping list already bought for it.' };
      }
    }
    reply.code(201);
    return prisma.mealPlanEntry.create({
      data: {
        mealPlanId: id,
        recipeId: data.recipeId,
        date: data.date, // undefined = staged/unassigned
        slot: data.slot,
        servingsPlanned: data.servingsPlanned,
      },
    });
  });

  // Stage a recipe into the current plan as unassigned (the "Add to plan" button).
  app.post('/meal-plans/stage', async (req, reply) => {
    const data = stageRecipeSchema.parse(req.body);
    const household = await getHousehold(req);
    const plan = await currentPlan(household.id);
    const recipe = await prisma.recipe.findUniqueOrThrow({ where: { id: data.recipeId } });
    const entry = await prisma.mealPlanEntry.create({
      data: {
        mealPlanId: plan.id,
        recipeId: data.recipeId,
        slot: data.slot,
        servingsPlanned: data.servings ?? recipe.servings ?? 2,
      },
      include: { recipe: true },
    });
    reply.code(201);
    return { planId: plan.id, planName: plan.name, entry };
  });

  // Assign a staged entry to one or more dates: first date fills the entry, extras clone it.
  app.post('/meal-plans/:id/entries/:entryId/assign', async (req, reply) => {
    const { id, entryId } = req.params as { id: string; entryId: string };
    const { dates } = assignEntrySchema.parse(req.body);
    const household = await requireEditor(req);
    const entry = await owned(household.id).mealPlanEntry(entryId);
    if (entry.lockedByListId) {
      reply.code(409);
      return { message: 'This meal is locked — a shopping list already bought for it.' };
    }
    const locks = await lockedDays(household.id);
    const blocked = dates.filter((d) => locks.has(dayKey(d)));
    if (blocked.length) {
      reply.code(409);
      return {
        message: `Locked day(s): ${blocked.map((d) => dayKey(d)).join(', ')} — already shopped for.`,
      };
    }

    const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
    const created = await prisma.$transaction(async (tx) => {
      await tx.mealPlanEntry.update({ where: { id: entryId }, data: { date: sorted[0] } });
      const extras = await Promise.all(
        sorted.slice(1).map((date) =>
          tx.mealPlanEntry.create({
            data: {
              mealPlanId: id,
              recipeId: entry.recipeId,
              date,
              slot: entry.slot,
              servingsPlanned: entry.servingsPlanned,
            },
          }),
        ),
      );
      // Stretch the plan window to cover assigned dates.
      const plan = await tx.mealPlan.findUniqueOrThrow({ where: { id } });
      const min = sorted[0]!;
      const max = sorted[sorted.length - 1]!;
      await tx.mealPlan.update({
        where: { id },
        data: {
          startDate: min < plan.startDate ? min : plan.startDate,
          endDate: max > plan.endDate ? max : plan.endDate,
        },
      });
      return extras;
    });
    return { assigned: sorted.length, createdExtra: created.length };
  });

  // ---- Recurring meals (rules) ----
  app.get('/meal-rules', async (req) => {
    const household = await getHousehold(req);
    return prisma.mealRule.findMany({
      where: { householdId: household.id, active: true },
      include: { recipe: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  });

  app.post('/meal-rules', async (req, reply) => {
    const data = mealRuleCreateSchema.parse(req.body);
    const household = await getHousehold(req);
    reply.code(201);
    return prisma.mealRule.create({
      data: { ...data, householdId: household.id },
      include: { recipe: { select: { id: true, name: true } } },
    });
  });

  app.delete('/meal-rules/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const household = await requireEditor(req);
    await owned(household.id).mealRule(id);
    await prisma.mealRule.delete({ where: { id } });
    reply.code(204);
  });

  // Materialize active rules into an existing plan's date range (idempotent per recipe+date).
  app.post('/meal-plans/:id/apply-rules', async (req) => {
    const { id } = req.params as { id: string };
    const household = await requireEditor(req);
    const plan = await prisma.mealPlan.findFirstOrThrow({
      where: { id, householdId: household.id },
      include: { entries: true },
    });
    const days = Math.max(1, Math.round((plan.endDate.getTime() - plan.startDate.getTime()) / DAY_MS) + 1);
    const rules = await activeRules(household.id);
    const wanted = materializeRules(rules, plan.startDate, days);
    const locks = await lockedDays(household.id);
    const existing = new Set(
      plan.entries.filter((e) => e.date).map((e) => `${e.recipeId}|${e.date!.toISOString().slice(0, 10)}`),
    );
    const fresh = wanted.filter(
      (w) =>
        !existing.has(`${w.recipeId}|${w.date.toISOString().slice(0, 10)}`) &&
        !locks.has(dayKey(w.date)),
    );
    await prisma.mealPlanEntry.createMany({
      data: fresh.map((w) => ({
        mealPlanId: id,
        recipeId: w.recipeId,
        date: w.date,
        slot: w.slot,
        servingsPlanned: w.servings ?? 2,
      })),
    });
    return { applied: fresh.length, skippedExisting: wanted.length - fresh.length };
  });

  // Drag & drop / rescale: move an entry (date, or null = unassigned) and/or change servings.
  app.patch('/meal-plans/:id/entries/:entryId', async (req, reply) => {
    const { entryId } = req.params as { entryId: string };
    const patch = moveEntrySchema.parse(req.body);
    const household = await requireEditor(req);
    const entry = await owned(household.id).mealPlanEntry(entryId);
    if (entry.lockedByListId) {
      reply.code(409);
      return { message: 'This meal is locked — a shopping list already bought for it.' };
    }
    if (patch.date) {
      const locks = await lockedDays(household.id);
      if (locks.has(dayKey(patch.date))) {
        reply.code(409);
        return { message: 'That day is locked — a shopping list already bought for it.' };
      }
    }
    return prisma.mealPlanEntry.update({
      where: { id: entryId },
      data: {
        ...(patch.date !== undefined ? { date: patch.date } : {}),
        ...(patch.servingsPlanned !== undefined ? { servingsPlanned: patch.servingsPlanned } : {}),
      },
      include: {
        recipe: {
          select: { id: true, name: true, externalRating: true, imageUrl: true, servings: true },
        },
      },
    });
  });

  app.delete('/meal-plans/:id/entries/:entryId', async (req, reply) => {
    const { entryId } = req.params as { entryId: string };
    const household = await requireEditor(req);
    const entry = await owned(household.id).mealPlanEntry(entryId);
    if (entry.lockedByListId) {
      reply.code(409);
      return { message: 'This meal is locked — a shopping list already bought for it.' };
    }
    await prisma.mealPlanEntry.delete({ where: { id: entryId } });
    reply.code(204);
  });

  // Move a LOCKED meal (already shopped for) to a different day. Unlike PATCH this bypasses the
  // lock guard — that's the point. The lock follows the meal (lockedByListId stays), so the new
  // day becomes the locked one and the old day frees up (lockedDays is entry-based).
  app.post('/meal-plans/:id/entries/:entryId/reschedule', async (req, reply) => {
    const { entryId } = req.params as { entryId: string };
    const { date } = (req.body ?? {}) as { date?: string };
    if (!date) {
      reply.code(400);
      return { message: 'date required' };
    }
    const household = await requireEditor(req);
    await owned(household.id).mealPlanEntry(entryId);
    return prisma.mealPlanEntry.update({
      where: { id: entryId },
      data: { date: new Date(date) },
      include: {
        recipe: { select: { id: true, name: true, externalRating: true, imageUrl: true, servings: true } },
      },
    });
  });

  // Cancel a meal and RETURN its ingredients to the pantry as inventory lots (the inverse of
  // cooking, which consumes them). Scaled by the planned servings, like the cook path.
  app.post('/meal-plans/:id/entries/:entryId/cancel-return', async (req) => {
    const { entryId } = req.params as { entryId: string };
    const household = await requireEditor(req);
    const entry = await prisma.mealPlanEntry.findFirstOrThrow({
      where: { id: entryId, mealPlan: { householdId: household.id } },
      include: { recipe: { include: { ingredients: true } } },
    });
    const ratio = entry.servingsPlanned / (entry.recipe.servings || 1);
    let returned = 0;
    await prisma.$transaction(async (tx) => {
      for (const ing of entry.recipe.ingredients) {
        if (ing.optional || !ing.canonicalItemId || ing.baseQuantity == null) continue;
        await tx.inventoryLot.create({
          data: {
            householdId: household.id,
            canonicalItemId: ing.canonicalItemId,
            quantity: (Number(ing.quantity) * ratio).toString(),
            unit: ing.unit,
            baseQuantity: (Number(ing.baseQuantity) * ratio).toString(),
          },
        });
        returned++;
      }
      await tx.mealPlanEntry.delete({ where: { id: entryId } });
    });
    return { returned };
  });

  app.delete('/meal-plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const household = await requireEditor(req);
    await owned(household.id).mealPlan(id);
    await prisma.mealPlan.delete({ where: { id } });
    reply.code(204);
  });

  // Auto-generate a plan: score a candidate pool (favorites + top-rated sample + cookable),
  // then greedy-pick with variety constraints. Regenerating gives a different week (jitter).
  app.post('/meal-plans/generate', async (req, reply) => {
    const opts = generateMealPlanSchema.parse(req.body ?? {});
    const household = await getHousehold(req);

    // Dinner slots use a main-course category ALLOWLIST. Food.com categories are too messy
    // for a denylist (they include "Household Cleaner", "Teeth Whitener", "Bath/Beauty"…) —
    // only recipes in a recognizably main-dish category qualify. Applies to favorites too:
    // a favorited dessert still isn't dinner.
    const MAINS =
      'one dish|chicken|pork|meat|steak|stew|bean|lentil|chili|curr|spaghetti|penne|pasta|noodle|rice|lamb|ham\\b|roast|turkey|duck|veal|tuna|salmon|halibut|catfish|whitefish|crawfish|crab|lobster|shrimp|seafood|savory pie|tofu|soy|meatloaf|meatball|casserole|beef|goat|vegan|vegetarian|fish|dinner|main|soup|miscellaneous';
    const isDinner = opts.slot === 'dinner';
    const mainsRe = new RegExp(MAINS, 'i');
    const categoryOk = (category: string | null) =>
      !isDinner || (!!category && mainsRe.test(category));

    type Candidate = Recipe & {
      ingredients: (RecipeIngredient & {
        canonicalItem: {
          name: string;
          assumeStocked: boolean;
          gramsPerMl: unknown;
          gramsPerEach: unknown;
        } | null;
      })[];
    };
    const pool = new Map<string, Candidate>();
    const include = {
      ingredients: {
        include: {
          canonicalItem: {
            select: { name: true, assumeStocked: true, gramsPerMl: true, gramsPerEach: true },
          },
        },
      },
    } as const;

    // Favorites (per-org) always make the pool (category-filtered for dinner slots).
    const favIds = new Set(
      (await prisma.recipeFavorite.findMany({ where: { householdId: household.id }, select: { recipeId: true } })).map(
        (f) => f.recipeId,
      ),
    );
    for (const r of await prisma.recipe.findMany({
      where: { id: { in: [...favIds] } },
      include,
      take: 100,
    })) {
      if (categoryOk(r.category)) pool.set(r.id, r);
    }

    // Well-reviewed random sample (random() keeps regenerations fresh).
    // Sample well-regarded recipes; sources without review counts (Epicurious/TheMealDB)
    // qualify on rating alone or on having no rating data at all.
    const sampled = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Recipe"
      WHERE "householdId" = ${household.id}
        AND ("externalRating" >= 4 OR "externalRating" IS NULL)
        AND (NOT ${isDinner} OR (category IS NOT NULL AND lower(category) ~ ${MAINS.toLowerCase()}))
      ORDER BY random() LIMIT 300`;
    for (const r of await prisma.recipe.findMany({
      where: { id: { in: sampled.map((s) => s.id) } },
      include,
    }))
      pool.set(r.id, r);

    // Budget mode: pool the genuinely cheap mains — but only ones we've priced well enough
    // to trust (>=60% of ingredients), so fake-cheap partially-priced recipes don't win.
    if (opts.budget) {
      for (const r of await prisma.recipe.findMany({
        where: {
          householdId: household.id,
          estCostPerServing: { not: null },
          costCoverage: { gte: 0.6 },
          ...(isDinner ? { category: { not: null } } : {}),
        },
        orderBy: { estCostPerServing: 'asc' },
        include,
        take: 300,
      })) {
        if (categoryOk(r.category)) pool.set(r.id, r);
      }
    }

    // Recipes fully covered by the pantry (the cook-from-pantry set).
    if (opts.preferPantry) {
      for (const r of await prisma.recipe.findMany({
        where: {
          householdId: household.id,
          AND: [
            { ingredients: { some: { canonicalItemId: { not: null } } } },
            { ingredients: { none: { canonicalItemId: null, optional: false } } },
          ],
        },
        include,
        take: 300,
      })) {
        if (categoryOk(r.category)) pool.set(r.id, r);
      }
    }

    if (pool.size === 0) {
      reply.code(422);
      return { message: 'No candidate recipes — import or add recipes first' };
    }

    const pantry = await pantryLots(household.id);

    // Nutrition-aware: when household members have diet targets, nudge toward recipes that
    // portion well for one person's day (average member target — multi-person reconciliation).
    const dietRows = await prisma.dietProfile.findMany({
      where: { user: { householdId: household.id }, targetCalories: { not: null } },
      select: { targetCalories: true },
    });
    const perPersonTarget = dietRows.length
      ? Math.round(dietRows.reduce((s, d) => s + (d.targetCalories ?? 0), 0) / dietRows.length)
      : null;
    const calMap = perPersonTarget ? await batchCaloriesPerServing([...pool.keys()]) : new Map<string, number | null>();

    const scored = [...pool.values()].map((r) => {
      const cov = recipeCoverage(r.ingredients, pantry);
      const covFraction = cov.requiredCount > 0 ? cov.satisfiedCount / cov.requiredCount : 0;
      // Sources without review counts get a neutral confidence instead of zero.
      const confidence =
        r.externalRatingCount != null
          ? Math.min(1, Math.log1p(r.externalRatingCount) / Math.log(50))
          : 0.6;
      let score = (r.externalRating ?? 3) * confidence;
      if (opts.favoritesFirst && favIds.has(r.id)) score += 2.5;
      if (opts.preferPantry) score += 3 * covFraction + (cov.cookable ? 1 : 0);
      if (opts.budget) {
        // Real cost dominates, but only trust it when the recipe is well-priced; partially
        // priced (fake-cheap) and unpriced recipes are penalized so they can't sneak in.
        const trusted = (r.costCoverage ?? 0) >= 0.6;
        const cost = trusted && r.estCostPerServing != null ? Number(r.estCostPerServing) : null;
        if (cost != null) score += 6 * Math.max(0, 1 - cost / 10);
        else score -= 3;
        if (trusted) score += Math.min(1.5, (r.promoIngredients ?? 0) * 0.5);
      }
      if (perPersonTarget) score += 1.5 * mealFitScore(calMap.get(r.id) ?? null, perPersonTarget);
      score += Math.random(); // jitter: regenerate -> different week
      return { r, score };
    });
    scored.sort((a, b) => b.score - a.score);

    // The generator FILLS THE QUEUE: days that already have a meal or are locked by a
    // shopping list are skipped; rules claim their dates next; picks fill what's left.
    const start = opts.startDate ?? new Date();
    start.setHours(12, 0, 0, 0);
    const rangeEnd = new Date(start.getTime() + opts.days * 86_400_000);
    const [locks, existingEntries] = await Promise.all([
      lockedDays(household.id),
      prisma.mealPlanEntry.findMany({
        where: {
          mealPlan: { householdId: household.id },
          date: { gte: new Date(start.getTime() - 86_400_000), lt: rangeEnd },
        },
        select: { date: true },
      }),
    ]);
    const taken = new Set(existingEntries.filter((e) => e.date).map((e) => dayKey(e.date!)));
    for (const k of locks.keys()) taken.add(k);

    const ruleEntries = materializeRules(await activeRules(household.id), start, opts.days).filter(
      (r) => !taken.has(dayKey(r.date)),
    );
    for (const r of ruleEntries) taken.add(dayKey(r.date));

    const freeDates: Date[] = [];
    for (let i = 0; i < opts.days; i++) {
      const d = new Date(start.getTime() + i * 86_400_000);
      if (!taken.has(dayKey(d))) freeDates.push(d);
    }
    const picks: Candidate[] = [];
    const cuisineCount = new Map<string, number>();
    const categoryCount = new Map<string, number>();
    const pickFrom = (relaxed: boolean) => {
      for (const { r } of scored) {
        if (picks.length >= freeDates.length) break;
        if (picks.some((p) => p.id === r.id)) continue;
        if (!relaxed) {
          const cui = r.cuisine?.toLowerCase();
          const cat = r.category?.toLowerCase();
          if (cui && (cuisineCount.get(cui) ?? 0) >= 2) continue;
          if (cat && (categoryCount.get(cat) ?? 0) >= 2) continue;
          // Weekday evenings favor non-HARD recipes.
          const day = freeDates[picks.length]!.getDay();
          const weekday = day >= 1 && day <= 4;
          if (weekday && r.complexity === 'HARD') continue;
          if (cui) cuisineCount.set(cui, (cuisineCount.get(cui) ?? 0) + 1);
          if (cat) categoryCount.set(cat, (categoryCount.get(cat) ?? 0) + 1);
        }
        picks.push(r);
      }
    };
    pickFrom(false);
    if (picks.length < freeDates.length) pickFrom(true);

    // Add to the rolling queue plan rather than creating a new plan per generation.
    const plan = await currentPlan(household.id);
    await prisma.mealPlanEntry.createMany({
      data: [
        ...ruleEntries.map((e) => ({
          mealPlanId: plan.id,
          recipeId: e.recipeId,
          date: e.date,
          slot: e.slot,
          servingsPlanned: e.servings ?? 2,
        })),
        ...picks.map((r, i) => ({
          mealPlanId: plan.id,
          recipeId: r.id,
          date: freeDates[i]!,
          slot: opts.slot,
          servingsPlanned: r.servings || 2,
        })),
      ],
    });
    const withEntries = await prisma.mealPlan.findUniqueOrThrow({
      where: { id: plan.id },
      include: { entries: { include: { recipe: true }, where: { date: { gte: start, lt: rangeEnd } } } },
    });
    reply.code(201);
    return withEntries;
  });

  // Legacy per-plan list build (the queue's "going shopping" flow in shoppingLists.ts is
  // the primary path now).
  app.post('/meal-plans/:id/generate-list', async (req) => {
    const { id } = req.params as { id: string };
    const household = await getHousehold(req);
    const plan = await prisma.mealPlan.findFirstOrThrow({
      where: { id, householdId: household.id },
      include: {
        entries: {
          include: { recipe: { include: { ingredients: { include: { canonicalItem: true } } } } },
        },
      },
    });
    return buildShoppingList(household.id, plan.entries, {
      name: plan.name ? `${plan.name} list` : 'Shopping list',
      mealPlanId: plan.id,
    });
  });

  // The rolling meal queue: unassigned staging + upcoming dated meals + locked days.
  // The cutoff has a 36h grace window: clients send calendar days as local-noon dates, so a
  // strict server-midnight (UTC) cutoff would hide "today" entries for western timezones.
  app.get('/queue', async (req) => {
    const household = await getHousehold(req);
    const windowStart = new Date(Date.now() - 36 * 3_600_000);
    const recipeSelect = {
      select: { id: true, name: true, externalRating: true, imageUrl: true, servings: true },
    };
    const [unassigned, upcoming, locks] = await Promise.all([
      prisma.mealPlanEntry.findMany({
        where: { mealPlan: { householdId: household.id }, date: null },
        include: { recipe: recipeSelect },
        orderBy: { id: 'asc' },
      }),
      prisma.mealPlanEntry.findMany({
        where: { mealPlan: { householdId: household.id }, date: { gte: windowStart } },
        include: { recipe: recipeSelect },
        orderBy: { date: 'asc' },
      }),
      lockedDays(household.id),
    ]);
    return {
      unassigned,
      upcoming: upcoming.map((e) => ({
        ...e,
        locked: e.lockedByListId != null || locks.has(dayKey(e.date!)),
      })),
      lockedDayKeys: [...locks.keys()].sort(),
    };
  });
}
