import type { FastifyInstance } from 'fastify';
import { prisma } from '@meals/db';
import { settingsUpdateSchema } from '@meals/shared';
import { getHousehold } from '../lib/household.js';

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/settings', async (req) => {
    const household = await getHousehold(req);
    return {
      id: household.id,
      name: household.name,
      currency: household.currency,
      homeLat: household.homeLat,
      homeLng: household.homeLng,
      timeValuePerMinute: Number(household.timeValuePerMinute),
    };
  });

  app.patch('/settings', async (req) => {
    const data = settingsUpdateSchema.parse(req.body);
    const household = await getHousehold(req);
    const updated = await prisma.household.update({
      where: { id: household.id },
      data: {
        name: data.name,
        currency: data.currency,
        homeLat: data.homeLat,
        homeLng: data.homeLng,
        timeValuePerMinute: data.timeValuePerMinute?.toString(),
      },
    });
    return {
      id: updated.id,
      name: updated.name,
      currency: updated.currency,
      homeLat: updated.homeLat,
      homeLng: updated.homeLng,
      timeValuePerMinute: Number(updated.timeValuePerMinute),
    };
  });
}
