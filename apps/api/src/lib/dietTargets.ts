// Deterministic calorie + macro targets from a diet profile. The FORMULA (Mifflin–St Jeor +
// activity factor) is standard; the tunable numbers below (goal deltas, floors) and the diet
// macro splits are PROVISIONAL and flagged for a registered dietitian to review. Guidance only —
// not medical advice.
import type { ActivityLevel, BiologicalSex, DietGoal } from '@meals/db';

// Standard activity multipliers on top of BMR (Katch/Mifflin convention).
const ACTIVITY_MULT: Record<ActivityLevel, number> = {
  SEDENTARY: 1.2,
  LIGHT: 1.375,
  MODERATE: 1.55,
  ACTIVE: 1.725,
  VERY_ACTIVE: 1.9,
};

// --- RD-REVIEWABLE knobs (provisional) ---
// Daily calorie adjustment for the goal, applied to maintenance (TDEE).
export const GOAL_DELTA: Record<DietGoal, number> = { LOSE: -500, MAINTAIN: 0, GAIN: 350 };
// Safety floors so a large deficit never recommends an unsafe intake.
export const CALORIE_FLOOR: Record<BiologicalSex, number> = { FEMALE: 1200, MALE: 1500 };

export interface DietInputs {
  birthYear?: number | null;
  sex?: BiologicalSex | null;
  heightCm?: number | null;
  weightKg?: number | null;
  activityLevel?: ActivityLevel | null;
  goal?: DietGoal | null;
}

export interface MacroSplit {
  proteinPct: number;
  carbPct: number;
  fatPct: number;
}

export interface DietTargets {
  targetCalories: number;
  proteinG: number | null;
  carbG: number | null;
  fatG: number | null;
}

/** Age in whole years from birth year (current-year based; good enough for BMR). */
function ageFrom(birthYear: number): number {
  return Math.max(0, new Date().getFullYear() - birthYear);
}

/**
 * Compute cached targets. Returns null when the inputs needed for the calorie formula are
 * missing. Macros are null when no diet style (macro split) is chosen — calories still resolve.
 */
export function computeDietTargets(inp: DietInputs, split?: MacroSplit | null): DietTargets | null {
  const { birthYear, sex, heightCm, weightKg, activityLevel } = inp;
  if (!birthYear || !sex || !heightCm || !weightKg || !activityLevel) return null;

  const age = ageFrom(birthYear);
  // Mifflin–St Jeor BMR.
  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 'MALE' ? 5 : -161);
  const tdee = bmr * ACTIVITY_MULT[activityLevel];
  const goal = inp.goal ?? 'MAINTAIN';
  const target = Math.max(CALORIE_FLOOR[sex], Math.round((tdee + GOAL_DELTA[goal]) / 10) * 10);

  if (!split) return { targetCalories: target, proteinG: null, carbG: null, fatG: null };
  // Protein/carb 4 kcal/g, fat 9 kcal/g.
  return {
    targetCalories: target,
    proteinG: Math.round((target * split.proteinPct) / 100 / 4),
    carbG: Math.round((target * split.carbPct) / 100 / 4),
    fatG: Math.round((target * split.fatPct) / 100 / 9),
  };
}
