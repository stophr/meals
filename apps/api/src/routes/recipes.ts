import type { FastifyInstance } from 'fastify';
import { prisma } from '@meals/db';
import { recipeCreateSchema, recipeUpdateSchema } from '@meals/shared';
import { toBaseQuantity } from '@meals/core';
import { getHousehold } from '../lib/household.js';

export async function recipeRoutes(app: FastifyInstance) {
  app.get('/recipes', async () => {
    const household = await getHousehold();
    return prisma.recipe.findMany({
      where: { householdId: household.id },
      include: { ingredients: { include: { canonicalItem: true } } },
      orderBy: { name: 'asc' },
    });
  });

  app.get('/recipes/:id', async (req) => {
    const { id } = req.params as { id: string };
    return prisma.recipe.findUniqueOrThrow({
      where: { id },
      include: { ingredients: { include: { canonicalItem: true } } },
    });
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
    // If ingredients are supplied, replace them wholesale (simplest correct MVP semantics).
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
