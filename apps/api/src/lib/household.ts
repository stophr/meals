import { prisma } from '@meals/db';
import type { Household } from '@meals/db';

// MVP is single-household with no auth. Resolve (or lazily create) the one household every
// request operates on. Phase 3 replaces this with the authenticated user's household.
export async function getHousehold(): Promise<Household> {
  const existing = await prisma.household.findFirst({ orderBy: { createdAt: 'asc' } });
  if (existing) return existing;
  return prisma.household.create({ data: { name: 'My Household' } });
}
