import type { FastifyInstance } from 'fastify';
import { prisma } from '@meals/db';
import { substitutionCreateSchema } from '@meals/shared';
import { getHousehold, requireEditor } from '../lib/household.js';
import { owned } from '../lib/tenant.js';

export async function substitutionRoutes(app: FastifyInstance) {
  // Every substitution rule for the org (global + recipe-scoped), newest first.
  app.get('/substitutions', async (req) => {
    const household = await getHousehold(req);
    const rows = await prisma.ingredientSubstitution.findMany({
      where: { householdId: household.id },
      include: {
        fromItem: { select: { id: true, name: true } },
        toItem: { select: { id: true, name: true } },
        recipe: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      from: r.fromItem,
      to: r.toItem,
      recipe: r.recipe, // null = org-global
    }));
  });

  // Create or change a rule. Upsert on (org, fromItem, recipe) so re-substituting the same
  // ingredient just changes the target (remembered until reverted/changed).
  app.post('/substitutions', async (req, reply) => {
    const data = substitutionCreateSchema.parse(req.body);
    const household = await getHousehold(req);
    if (data.fromCanonicalItemId === data.toCanonicalItemId) {
      reply.code(422);
      return { message: 'Pick a different ingredient to substitute with.' };
    }
    // Upsert on (org, fromItem, recipe). Done as find-then-write because the unique key
    // includes a nullable column (recipeId) which Prisma's upsert where can't type.
    const existing = await prisma.ingredientSubstitution.findFirst({
      where: {
        householdId: household.id,
        fromCanonicalItemId: data.fromCanonicalItemId,
        recipeId: data.recipeId ?? null,
      },
    });
    reply.code(existing ? 200 : 201);
    return existing
      ? prisma.ingredientSubstitution.update({
          where: { id: existing.id },
          data: { toCanonicalItemId: data.toCanonicalItemId },
        })
      : prisma.ingredientSubstitution.create({
          data: {
            householdId: household.id,
            fromCanonicalItemId: data.fromCanonicalItemId,
            toCanonicalItemId: data.toCanonicalItemId,
            recipeId: data.recipeId,
          },
        });
  });

  // Revert a rule.
  app.delete('/substitutions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const household = await requireEditor(req);
    await owned(household.id).substitution(id);
    await prisma.ingredientSubstitution.delete({ where: { id } });
    reply.code(204);
  });
}
