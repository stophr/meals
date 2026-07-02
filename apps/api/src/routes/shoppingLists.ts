import type { FastifyInstance } from 'fastify';
import { prisma } from '@meals/db';
import { optimize } from '@meals/core';
import {
  shoppingListCreateSchema,
  shoppingListItemUpdateSchema,
  shopFromQueueSchema,
} from '@meals/shared';
import type { OptimizationResult } from '@meals/shared';
import { getHousehold } from '../lib/household.js';
import { buildOptimizerInput } from '../lib/optimizerInput.js';
import { buildShoppingList } from '../lib/shoppingBuild.js';
import { noonToday } from '../lib/queue.js';
import { computeItemOptions, pickBest } from '../lib/shoppingOptions.js';

function dayLabel(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export async function shoppingListRoutes(app: FastifyInstance) {
  app.get('/shopping-lists', async () => {
    const household = await getHousehold();
    return prisma.shoppingList.findMany({
      where: { householdId: household.id },
      orderBy: { createdAt: 'desc' },
    });
  });

  app.get('/shopping-lists/:id', async (req) => {
    const { id } = req.params as { id: string };
    return prisma.shoppingList.findUniqueOrThrow({
      where: { id },
      include: { items: { include: { canonicalItem: true } } },
    });
  });

  app.post('/shopping-lists', async (req, reply) => {
    const data = shoppingListCreateSchema.parse(req.body);
    const household = await getHousehold();
    reply.code(201);
    return prisma.shoppingList.create({
      data: { householdId: household.id, name: data.name, mealPlanId: data.mealPlanId },
    });
  });

  // "I'm going to the grocery store": build a list from the next N days of queued meals
  // (skipping meals already bought for), then LOCK those days.
  app.post('/shopping-lists/from-queue', async (req, reply) => {
    const { days } = shopFromQueueSchema.parse(req.body ?? {});
    const household = await getHousehold();

    const start = noonToday();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + days * 86_400_000 - 1);

    const entries = await prisma.mealPlanEntry.findMany({
      where: {
        mealPlan: { householdId: household.id },
        date: { gte: start, lte: end },
        lockedByListId: null,
      },
      include: {
        recipe: { include: { ingredients: { include: { canonicalItem: true } } } },
      },
    });
    if (!entries.length) {
      reply.code(422);
      return {
        message: `No unlocked meals queued in the next ${days} day(s) — add meals to the queue first.`,
      };
    }

    const coverageEnd = new Date(start.getTime() + (days - 1) * 86_400_000);
    const list = await buildShoppingList(household.id, entries, {
      name: `Shop ${dayLabel(start)} – ${dayLabel(coverageEnd)}`,
      coverageStart: start,
      coverageEnd,
    });
    await prisma.mealPlanEntry.updateMany({
      where: { id: { in: entries.map((e) => e.id) } },
      data: { lockedByListId: list.id },
    });
    reply.code(201);
    return { ...list, lockedMeals: entries.length, coverageDays: days };
  });

  // Run the time-vs-savings optimizer, persist the result, and pre-assign each item to the
  // recommended option's store/product.
  app.post('/shopping-lists/:id/optimize', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { timeValue?: string; maxStores?: string };
    const household = await getHousehold();

    const timeValue = q.timeValue ? Number(q.timeValue) : Number(household.timeValuePerMinute);
    const maxStores = q.maxStores ? Number(q.maxStores) : undefined;

    const { input } = await buildOptimizerInput(id, household.id, timeValue, maxStores);
    const result: OptimizationResult = optimize(input);

    const recommended = result.options[result.recommendedIndex];
    await prisma.$transaction(async (tx) => {
      await tx.shoppingList.update({
        where: { id },
        data: { status: 'optimized', optimizationResult: result as unknown as object },
      });
      if (recommended) {
        for (const a of recommended.assignments) {
          await tx.shoppingListItem.update({
            where: { id: a.itemId },
            data: {
              assignedProviderId: a.providerId,
              chosenProductId: a.productId,
              estimatedPrice: a.cost.toFixed(2),
            },
          });
        }
      }
    });

    return result;
  });

  app.patch('/shopping-lists/:id/items/:itemId', async (req) => {
    const { itemId } = req.params as { itemId: string };
    const data = shoppingListItemUpdateSchema.parse(req.body);
    return prisma.shoppingListItem.update({ where: { id: itemId }, data });
  });

  // Per-item provider options (every store × size with a current price).
  app.get('/shopping-lists/:id/options', async (req) => {
    const { id } = req.params as { id: string };
    const household = await getHousehold();
    return { items: await computeItemOptions(household.id, id) };
  });

  // Flip every item to its best option by unit price or total cost, and persist.
  app.post('/shopping-lists/:id/auto-select', async (req) => {
    const { id } = req.params as { id: string };
    const mode = ((req.body as { mode?: string } | null)?.mode === 'unit' ? 'unit' : 'total') as
      | 'unit'
      | 'total';
    const household = await getHousehold();
    const items = await computeItemOptions(household.id, id);
    const picks = pickBest(items, mode);
    await prisma.$transaction(
      picks.map((p) =>
        prisma.shoppingListItem.update({
          where: { id: p.itemId },
          data: {
            assignedProviderId: p.option.providerId,
            chosenProductId: p.option.productId,
            estimatedPrice: p.option.totalCost.toFixed(2),
          },
        }),
      ),
    );
    return { mode, selected: picks.length, unpriced: items.length - picks.length };
  });

  // Split the list per store, with totals and whether each store supports cart fill.
  app.post('/shopping-lists/:id/build', async (req) => {
    const { id } = req.params as { id: string };
    const household = await getHousehold();
    const items = await computeItemOptions(household.id, id);
    const providers = await prisma.provider.findMany({ where: { householdId: household.id } });
    const krogerToken = await prisma.integrationToken.findUnique({
      where: { householdId_kind: { householdId: household.id, kind: 'kroger' } },
    });

    const groups = new Map<
      string,
      { providerId: string; name: string; canFillCart: boolean; total: number; items: unknown[] }
    >();
    const unpriced: string[] = [];

    for (const item of items) {
      // Use the chosen option; fall back to cheapest total if nothing chosen yet.
      const chosen =
        item.options.find((o) => o.productId === item.chosenProductId) ?? item.options[0];
      if (!chosen) {
        unpriced.push(item.name);
        continue;
      }
      const provider = providers.find((p) => p.id === chosen.providerId);
      const integ = provider?.integration as { type?: string } | null;
      let g = groups.get(chosen.providerId);
      if (!g) {
        g = {
          providerId: chosen.providerId,
          name: chosen.providerName,
          canFillCart: integ?.type === 'kroger' && !!krogerToken,
          total: 0,
          items: [],
        };
        groups.set(chosen.providerId, g);
      }
      g.total = Math.round((g.total + chosen.totalCost) * 100) / 100;
      g.items.push({
        name: item.name,
        brand: chosen.brand,
        size: chosen.size,
        packsNeeded: chosen.packsNeeded,
        totalCost: chosen.totalCost,
      });
    }

    const stores = [...groups.values()].sort((a, b) => b.total - a.total);
    return {
      stores,
      grandTotal: Math.round(stores.reduce((s, g) => s + g.total, 0) * 100) / 100,
      unpriced,
    };
  });

  app.delete('/shopping-lists/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.shoppingList.delete({ where: { id } });
    reply.code(204);
  });
}
