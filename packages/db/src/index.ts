// Re-export the generated Prisma client plus a lazily-created singleton so every
// workspace package shares one connection pool in dev (avoids exhausting Postgres
// connections during hot-reload).

export * from '../generated/client/index.js';
import { PrismaClient } from '../generated/client/index.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
