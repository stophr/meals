import type { FastifyInstance } from 'fastify';
import { prisma, Unit } from '@meals/db';
import { mealPlanCreateSchema, mealPlanEntryCreateSchema } from '@meals/shared';
import { getHousehold } from '../lib/household.js';

export async function mealPlanRoutes(app: FastifyInstance) {
  app.get('/meal-plans', async () => {
    const household = await getHousehold();
    return prisma.mealPlan.findMany({
      where: { householdId: household.id },
      include: { entries: { include: { recipe: true } } },
      orderBy: { startDate: 'desc' },
    });
  });

  app.get('/meal-plans/:id', async (req) => {
    const { id } = req.params as { id: string };
    return prisma.mealPlan.findUniqueOrThrow({
      where: { id },
      include: { entries: { include: { recipe: true } }, shoppingLists: true },
    });
  });

  app.post('/meal-plans', async (req, reply) => {
    const data = mealPlanCreateSchema.parse(req.body);
    const household = await getHousehold();
    reply.code(201);
    return prisma.mealPlan.create({
      data: { householdId: household.id, name: data.name, startDate: data.startDate, endDate: data.endDate },
    });
  });

  app.post('/meal-plans/:id/entries', async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = mealPlanEntryCreateSchema.parse(req.body);
    reply.code(201);
    return prisma.mealPlanEntry.create({
      data: {
        mealPlanId: id,
        recipeId: data.recipeId,
        date: data.date,
        slot: data.slot,
        servingsPlanned: data.servingsPlanned,
      },
    });
  });

  app.delete('/meal-plans/:id/entries/:entryId', async (req, reply) => {
    const { entryId } = req.params as { entryId: string };
    await prisma.mealPlanEntry.delete({ where: { id: entryId } });
    reply.code(204);
  });

  app.delete('/meal-plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.mealPlan.delete({ where: { id } });
    reply.code(204);
  });

  // Aggregate ingredients across the plan (scaled by servings), subtract inventory on hand,
  // and materialize a shopping list of what still needs buying — all in base units.
  app.post('/meal-plans/:id/generate-list', async (req) => {
    const { id } = req.params as { id: string };
    const household = await getHousehold();

    const plan = await prisma.mealPlan.findUniqueOrThrow({
      where: { id },
      include: {
        entries: {
          include: { recipe: { include: { ingredients: { include: { canonicalItem: true } } } } },
        },
      },
    });

    // canonicalItemId -> { neededBase, unit, name }
    const needed = new Map<string, { base: number; unit: Unit; name: string }>();
    for (const entry of plan.entries) {
      const servings = entry.recipe.servings || 1;
      const ratio = entry.servingsPlanned / servings;
      for (const ing of entry.recipe.ingredients) {
        if (!ing.canonicalItemId || ing.baseQuantity == null || ing.optional) continue;
        const add = Number(ing.baseQuantity) * ratio;
        const prev = needed.get(ing.canonicalItemId);
        const unit = ing.canonicalItem?.baseUnit ?? ing.unit;
        if (prev) prev.base += add;
        else needed.set(ing.canonicalItemId, { base: add, unit, name: ing.canonicalItem?.name ?? 'item' });
      }
    }

    // Subtract inventory on hand.
    const inventory = await prisma.inventoryLot.groupBy({
      by: ['canonicalItemId'],
      where: { householdId: household.id, canonicalItemId: { in: [...needed.keys()] } },
      _sum: { baseQuantity: true },
    });
    for (const row of inventory) {
      const entry = needed.get(row.canonicalItemId);
      if (entry && row._sum.baseQuantity) entry.base -= Number(row._sum.baseQuantity);
    }

    const items = [...needed.entries()].filter(([, v]) => v.base > 0.0001);

    return prisma.shoppingList.create({
      data: {
        householdId: household.id,
        mealPlanId: plan.id,
        name: plan.name ? `${plan.name} list` : 'Shopping list',
        items: {
          create: items.map(([canonicalItemId, v]) => ({
            canonicalItemId,
            quantityNeeded: v.base.toString(),
            unit: v.unit,
            baseQuantityNeeded: v.base.toString(),
          })),
        },
      },
      include: { items: { include: { canonicalItem: true } } },
    });
  });
}
