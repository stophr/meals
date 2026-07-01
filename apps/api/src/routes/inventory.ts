import type { FastifyInstance } from 'fastify';
import { prisma } from '@meals/db';
import { inventoryCreateSchema, inventoryUpdateSchema, inventoryConsumeSchema } from '@meals/shared';
import { toBaseQuantity } from '@meals/core';
import { getHousehold } from '../lib/household.js';

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
    let remaining = toBaseQuantity(data.quantity, data.unit).baseQuantity;

    const lots = await prisma.inventoryLot.findMany({
      where: { householdId: household.id, canonicalItemId: data.canonicalItemId },
      orderBy: [{ expiresAt: 'asc' }, { purchasedAt: 'asc' }],
    });

    const consumed: string[] = [];
    for (const lot of lots) {
      if (remaining <= 0) break;
      const lotBase = Number(lot.baseQuantity);
      if (lotBase <= remaining) {
        remaining -= lotBase;
        await prisma.inventoryLot.delete({ where: { id: lot.id } });
        consumed.push(lot.id);
      } else {
        const left = lotBase - remaining;
        const ratio = left / lotBase;
        await prisma.inventoryLot.update({
          where: { id: lot.id },
          data: {
            baseQuantity: left.toString(),
            quantity: (Number(lot.quantity) * ratio).toString(),
          },
        });
        remaining = 0;
      }
    }
    return { consumedLotIds: consumed, shortfallBase: Math.max(0, remaining) };
  });
}
