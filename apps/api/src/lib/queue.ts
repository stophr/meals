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

/** Map of locked day-key -> shopping list id, across all lists with a coverage range. */
export async function lockedDays(householdId: string): Promise<Map<string, string>> {
  const lists = await prisma.shoppingList.findMany({
    where: { householdId, coverageStart: { not: null }, coverageEnd: { not: null } },
    select: { id: true, coverageStart: true, coverageEnd: true },
  });
  const out = new Map<string, string>();
  for (const list of lists) {
    for (
      let t = list.coverageStart!.getTime();
      t <= list.coverageEnd!.getTime() + 1;
      t += 86_400_000
    ) {
      out.set(dayKey(new Date(t)), list.id);
    }
  }
  return out;
}
