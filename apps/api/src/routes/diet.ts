import type { FastifyInstance } from 'fastify';
import { prisma } from '@meals/db';
import type { ActivityLevel, BiologicalSex, DietGoal } from '@meals/db';
import { getPrincipal } from '../lib/principal.js';
import { computeDietTargets } from '../lib/dietTargets.js';

const ACTIVITIES = ['SEDENTARY', 'LIGHT', 'MODERATE', 'ACTIVE', 'VERY_ACTIVE'];
const GOALS = ['LOSE', 'MAINTAIN', 'GAIN'];

export async function dietRoutes(app: FastifyInstance) {
  // The selectable regimens (RD-reviewable). Public within the app; no household scoping needed.
  app.get('/diet-styles', async () => prisma.dietStyle.findMany({ orderBy: { sortOrder: 'asc' } }));

  // Current user's diet profile (per person — age/activity are personal).
  app.get('/diet-profile', async (req) => {
    const p = await getPrincipal(req);
    const profile = await prisma.dietProfile.findUnique({
      where: { userId: p.userId },
      include: { dietStyle: true },
    });
    return { profile };
  });

  // Upsert the current user's profile; recompute + cache calorie/macro targets from the inputs
  // and chosen style. Targets are GUIDANCE ONLY (not medical advice) and provisional until the
  // dietitian reviews the style numbers.
  app.post('/diet-profile', async (req) => {
    const p = await getPrincipal(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (v == null || v === '' ? null : Number(v));

    const sex: BiologicalSex | null = b.sex === 'MALE' || b.sex === 'FEMALE' ? (b.sex as BiologicalSex) : null;
    const activityLevel: ActivityLevel | null =
      typeof b.activityLevel === 'string' && ACTIVITIES.includes(b.activityLevel) ? (b.activityLevel as ActivityLevel) : null;
    const goal: DietGoal = typeof b.goal === 'string' && GOALS.includes(b.goal) ? (b.goal as DietGoal) : 'MAINTAIN';
    const dietStyleId = typeof b.dietStyleId === 'string' && b.dietStyleId ? b.dietStyleId : null;

    const inputs = {
      birthYear: num(b.birthYear),
      sex,
      heightCm: num(b.heightCm),
      weightKg: num(b.weightKg),
      activityLevel,
      goal,
    };
    const style = dietStyleId ? await prisma.dietStyle.findUnique({ where: { id: dietStyleId } }) : null;
    const targets = computeDietTargets(
      inputs,
      style ? { proteinPct: style.proteinPct, carbPct: style.carbPct, fatPct: style.fatPct } : null,
    );

    const data = {
      birthYear: inputs.birthYear,
      sex,
      heightCm: inputs.heightCm,
      weightKg: inputs.weightKg,
      activityLevel,
      goal,
      dietStyleId,
      targetCalories: targets?.targetCalories ?? null,
      proteinG: targets?.proteinG ?? null,
      carbG: targets?.carbG ?? null,
      fatG: targets?.fatG ?? null,
    };
    const profile = await prisma.dietProfile.upsert({
      where: { userId: p.userId },
      create: { userId: p.userId, ...data },
      update: data,
      include: { dietStyle: true },
    });
    return { profile };
  });
}
