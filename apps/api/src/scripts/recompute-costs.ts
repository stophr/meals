// Recompute every recipe's cost estimate from current store prices.
// Run after price syncs:  pnpm --filter @meals/api exec tsx src/scripts/recompute-costs.ts

import { prisma } from '@meals/db';
import { recomputeAllRecipeCosts } from '../lib/recipeCost.js';

async function main() {
  const household = await prisma.household.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const t = Date.now();
  const res = await recomputeAllRecipeCosts(household.id);
  console.log(
    `DONE in ${Math.round((Date.now() - t) / 1000)}s — costed ${res.costed} recipes, ${res.skipped} unpriceable (no priced ingredients yet)`,
  );
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
