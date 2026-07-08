/**
 * Seed the selectable diet styles (feature #16). Macro splits are PROVISIONAL — rdReviewed=false
 * until a registered dietitian vets the numbers/notes. Idempotent (upsert by key); safe to re-run,
 * and re-running does NOT clobber an rdReviewed=true row's numbers (only fills name/description).
 *
 * Usage: pnpm --filter @meals/api exec tsx src/scripts/seed-diet-styles.ts
 */
import { prisma } from '@meals/db';

// P/C/F are % of daily calories and must sum to 100. Provisional — for RD review.
export const DIET_STYLES = [
  { key: 'balanced', name: 'Balanced', proteinPct: 20, carbPct: 50, fatPct: 30, sortOrder: 1,
    description: 'General-purpose balanced macros.', notes: 'Default starting point.' },
  { key: 'high_protein', name: 'High-Protein', proteinPct: 35, carbPct: 40, fatPct: 25, sortOrder: 2,
    description: 'Higher protein for satiety and muscle retention.', notes: null },
  { key: 'lower_carb', name: 'Lower-Carb', proteinPct: 30, carbPct: 25, fatPct: 45, sortOrder: 3,
    description: 'Reduced carbohydrate, higher fat.', notes: null },
  { key: 'keto', name: 'Keto', proteinPct: 20, carbPct: 5, fatPct: 75, sortOrder: 4,
    description: 'Very low carb, high fat.', notes: 'Clinical pattern — RD should confirm suitability.' },
  { key: 'mediterranean', name: 'Mediterranean', proteinPct: 20, carbPct: 45, fatPct: 35, sortOrder: 5,
    description: 'Mediterranean pattern: whole foods, olive oil, fish, legumes.', notes: null },
  { key: 'plant_based', name: 'Plant-Based', proteinPct: 18, carbPct: 55, fatPct: 27, sortOrder: 6,
    description: 'Vegetarian / vegan pattern.', notes: 'Watch protein sources + B12; RD to advise.' },
  { key: 'performance', name: 'Performance', proteinPct: 25, carbPct: 50, fatPct: 25, sortOrder: 7,
    description: 'Higher carbohydrate for endurance and high activity.', notes: null },
] as const;

async function main() {
  for (const s of DIET_STYLES) {
    const existing = await prisma.dietStyle.findUnique({ where: { key: s.key } });
    if (existing?.rdReviewed) {
      // Preserve dietitian-approved numbers; only refresh copy.
      await prisma.dietStyle.update({ where: { key: s.key }, data: { name: s.name, description: s.description, sortOrder: s.sortOrder } });
    } else {
      await prisma.dietStyle.upsert({
        where: { key: s.key },
        create: { ...s, notes: s.notes ?? undefined },
        update: { ...s, notes: s.notes ?? undefined },
      });
    }
  }
  const n = await prisma.dietStyle.count();
  console.log(`Seeded diet styles. Total: ${n} (all provisional until rdReviewed=true).`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
