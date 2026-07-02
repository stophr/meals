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

  app.delete('/shopping-lists/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.shoppingList.delete({ where: { id } });
    reply.code(204);
  });
}
