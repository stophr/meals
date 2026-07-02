import type { FastifyInstance } from 'fastify';
import { prisma } from '@meals/db';
import { inventoryCreateSchema, inventoryUpdateSchema, inventoryConsumeSchema } from '@meals/shared';
import { toBaseQuantity } from '@meals/core';
import { getHousehold } from '../lib/household.js';
import { consumeFromInventory } from '../lib/inventory.js';

export async function inventoryRoutes(app: FastifyInstance) {
  app.get('/inventory', async () => {
    const household = await getHousehold();
    return prisma.inventoryLot.findMany({
      where: { householdId: household.id },
      include: { canonicalItem: true },
      orderBy: [{ expiresAt: 'asc' }, { purchasedAt: 'asc' }],
    });
  });

  app.post('/inventory', async (req, reply) => {
    const data = inventoryCreateSchema.parse(req.body);
    const household = await getHousehold();
    reply.code(201);
    return prisma.inventoryLot.create({
      data: {
        householdId: household.id,
        canonicalItemId: data.canonicalItemId,
        quantity: data.quantity.toString(),
        unit: data.unit,
        baseQuantity: toBaseQuantity(data.quantity, data.unit).baseQuantity.toString(),
        location: data.location,
        purchasedAt: data.purchasedAt,
        expiresAt: data.expiresAt,
      },
    });
  });

  app.patch('/inventory/:id', async (req) => {
    const { id } = req.params as { id: string };
    const data = inventoryUpdateSchema.parse(req.body);
    const patch: Record<string, unknown> = { ...data };
    if (data.quantity !== undefined) {
      patch.quantity = data.quantity.toString();
      const existing = await prisma.inventoryLot.findUniqueOrThrow({ where: { id } });
      patch.baseQuantity = toBaseQuantity(data.quantity, data.unit ?? existing.unit).baseQuantity.toString();
    }
    return prisma.inventoryLot.update({ where: { id }, data: patch });
  });

  app.delete('/inventory/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.inventoryLot.delete({ where: { id } });
    reply.code(204);
  });

  // Deduct a quantity across lots, FIFO by expiry (used when a meal is cooked).
  app.post('/inventory/consume', async (req) => {
    const data = inventoryConsumeSchema.parse(req.body);
    const household = await getHousehold();
    const base = toBaseQuantity(data.quantity, data.unit).baseQuantity;
    return consumeFromInventory(household.id, data.canonicalItemId, base);
  });
}
