import { prisma } from '@meals/db';

// Day-level locking: a calendar day is locked when a shopping list's coverage range
// includes it. Locked days reject meal edits (the groceries are already bought).

export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function noonToday(): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d;
}

/**
 * Map of locked day-key -> shopping list id. A day is locked when it holds a meal already
 * bought for (entry.lockedByListId). Entry-based (not coverage-range) so a non-contiguous
 * day pick — shop Mon & Wed, skip Tue — leaves the skipped day free. Lists that have been
 * archived no longer lock anything.
 */
export async function lockedDays(householdId: string): Promise<Map<string, string>> {
  const entries = await prisma.mealPlanEntry.findMany({
    where: {
      mealPlan: { householdId },
      date: { not: null },
      lockedByListId: { not: null },
      lockedByList: { archivedAt: null },
    },
    select: { date: true, lockedByListId: true },
  });
  const out = new Map<string, string>();
  for (const e of entries) out.set(dayKey(e.date!), e.lockedByListId!);
  return out;
}
