import type { FastifyInstance } from 'fastify';
import { prisma } from '@meals/db';
import { optimize } from '@meals/core';
import { shoppingListCreateSchema, shoppingListItemUpdateSchema } from '@meals/shared';
import type { OptimizationResult } from '@meals/shared';
import { getHousehold } from '../lib/household.js';
import { buildOptimizerInput } from '../lib/optimizerInput.js';

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
