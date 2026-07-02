import { prisma } from '@meals/db';
import type { MealRule } from '@meals/db';

// Materialize recurring-meal rules into concrete (recipeId, date) pairs for a range.
// RANDOM_* kinds draw a fresh random day per week/month window; fixed kinds land on their
// weekday/day-of-month. Materialization is idempotent at the call site (existing
// recipe+date entries are skipped).

export interface MaterializedEntry {
  recipeId: string;
  date: Date;
  slot: string;
  servings: number | null;
}

const DAY_MS = 86_400_000;

function atNoon(d: Date): Date {
  const out = new Date(d);
  out.setHours(12, 0, 0, 0);
  return out;
}

export function materializeRules(rules: MealRule[], start: Date, days: number): MaterializedEntry[] {
  const from = atNoon(start);
  const out: MaterializedEntry[] = [];

  for (const rule of rules) {
    if (!rule.active) continue;
    const dates: Date[] = [];

    if (rule.kind === 'DAILY') {
      for (let i = 0; i < days; i++) dates.push(new Date(from.getTime() + i * DAY_MS));
    } else if (rule.kind === 'WEEKLY') {
      const weekday = rule.weekday ?? rule.createdAt.getDay();
      for (let i = 0; i < days; i++) {
        const d = new Date(from.getTime() + i * DAY_MS);
        if (d.getDay() === weekday) dates.push(d);
      }
    } else if (rule.kind === 'MONTHLY') {
      const dom = rule.dayOfMonth ?? rule.createdAt.getDate();
      for (let i = 0; i < days; i++) {
        const d = new Date(from.getTime() + i * DAY_MS);
        const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        if (d.getDate() === Math.min(dom, lastDay)) dates.push(d);
      }
    } else if (rule.kind === 'RANDOM_WEEKLY') {
      for (let i = 0; i < days; i += 7) {
        const window = Math.min(7, days - i);
        const offset = Math.floor(Math.random() * window);
        dates.push(new Date(from.getTime() + (i + offset) * DAY_MS));
      }
    } else if (rule.kind === 'RANDOM_MONTHLY') {
      // One random day per calendar month intersecting the range.
      const months = new Map<string, Date[]>();
      for (let i = 0; i < days; i++) {
        const d = new Date(from.getTime() + i * DAY_MS);
        const key = `${d.getFullYear()}-${d.getMonth()}`;
        const list = months.get(key);
        if (list) list.push(d);
        else months.set(key, [d]);
      }
      for (const daysInMonth of months.values()) {
        dates.push(daysInMonth[Math.floor(Math.random() * daysInMonth.length)]!);
      }
    }

    for (const date of dates) {
      out.push({ recipeId: rule.recipeId, date, slot: rule.slot, servings: rule.servings });
    }
  }
  return out;
}

export async function activeRules(householdId: string): Promise<MealRule[]> {
  return prisma.mealRule.findMany({ where: { householdId, active: true } });
}
