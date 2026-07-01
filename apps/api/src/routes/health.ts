import type { FastifyInstance } from 'fastify';
import { prisma } from '@meals/db';
import type { HealthResponse } from '@meals/shared';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (): Promise<HealthResponse> => {
    let db: 'up' | 'down' = 'down';
    try {
      await prisma.$queryRaw`SELECT 1`;
      db = 'up';
    } catch {
      db = 'down';
    }
    return { status: 'ok', db, time: new Date().toISOString() };
  });
}
