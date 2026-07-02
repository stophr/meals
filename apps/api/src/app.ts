import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { Prisma } from '@meals/db';
import { env } from './env.js';
import { healthRoutes } from './routes/health.js';
import { providerRoutes } from './routes/providers.js';
import { itemRoutes } from './routes/items.js';
import { recipeRoutes } from './routes/recipes.js';
import { inventoryRoutes } from './routes/inventory.js';
import { priceRoutes } from './routes/prices.js';
import { mealPlanRoutes } from './routes/mealPlans.js';
import { shoppingListRoutes } from './routes/shoppingLists.js';
import { settingsRoutes } from './routes/settings.js';
import { ingestRoutes } from './routes/ingest.js';
import { integrationRoutes } from './routes/integrations.js';

export async function buildApp() {
  const app = Fastify({ logger: env.NODE_ENV !== 'test' });

  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
  });
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024 } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ message: 'Validation failed', issues: err.issues });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return reply.code(404).send({ message: 'Not found' });
    }
    app.log.error(err);
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    const message = err instanceof Error ? err.message : 'Internal error';
    return reply.code(statusCode).send({ message });
  });

  await app.register(healthRoutes);
  await app.register(providerRoutes);
  await app.register(itemRoutes);
  await app.register(recipeRoutes);
  await app.register(inventoryRoutes);
  await app.register(priceRoutes);
  await app.register(mealPlanRoutes);
  await app.register(shoppingListRoutes);
  await app.register(settingsRoutes);
  await app.register(ingestRoutes);
  await app.register(integrationRoutes);

  return app;
}
