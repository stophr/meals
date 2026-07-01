import type { FastifyInstance } from 'fastify';
import { prisma } from '@meals/db';
import { providerCreateSchema, providerUpdateSchema } from '@meals/shared';
import { getHousehold } from '../lib/household.js';

export async function providerRoutes(app: FastifyInstance) {
  app.get('/providers', async () => {
    const household = await getHousehold();
    return prisma.provider.findMany({ where: { householdId: household.id }, orderBy: { name: 'asc' } });
  });

  app.post('/providers', async (req, reply) => {
    const data = providerCreateSchema.parse(req.body);
    const household = await getHousehold();
    reply.code(201);
    return prisma.provider.create({ data: { ...data, householdId: household.id } });
  });

  app.patch('/providers/:id', async (req) => {
    const { id } = req.params as { id: string };
    const data = providerUpdateSchema.parse(req.body);
    return prisma.provider.update({ where: { id }, data });
  });

  app.delete('/providers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.provider.delete({ where: { id } });
    reply.code(204);
  });
}
