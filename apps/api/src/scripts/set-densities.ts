// One-time (idempotent) seeding of density factors so the pantry can reconcile weight <->
// volume <-> count for common staples (a "5 lb sugar bag" vs "2 cups sugar", "3 eggs" vs
// "150 g egg"). Values are approximate kitchen references; override per item in the pantry.
//
// Usage: pnpm --filter @meals/api exec tsx src/scripts/set-densities.ts [--force]

import { prisma } from '@meals/db';

// grams per millilitre (density)
const DENSITY: Record<string, number> = {
  water: 1.0, milk: 1.03, cream: 1.0, 'heavy cream': 1.0, buttermilk: 1.03, yogurt: 1.03,
  'greek yogurt': 1.05, 'sour cream': 1.0,
  sugar: 0.85, 'granulated sugar': 0.85, 'white sugar': 0.85, 'caster sugar': 0.85,
  'brown sugar': 0.93, 'powdered sugar': 0.56, 'confectioners sugar': 0.56,
  flour: 0.53, 'all-purpose flour': 0.53, 'all purpose flour': 0.53, 'bread flour': 0.53,
  'whole wheat flour': 0.51, 'cake flour': 0.45, cornstarch: 0.54, cornmeal: 0.6,
  'cocoa powder': 0.52, 'baking powder': 0.9, 'baking soda': 0.9,
  salt: 1.2, 'table salt': 1.2, 'kosher salt': 0.69, 'sea salt': 1.0,
  'olive oil': 0.91, 'vegetable oil': 0.92, 'canola oil': 0.92, oil: 0.92, 'coconut oil': 0.92,
  butter: 0.911, honey: 1.42, 'maple syrup': 1.37, molasses: 1.4, 'corn syrup': 1.38,
  rice: 0.85, 'white rice': 0.85, oats: 0.41, 'rolled oats': 0.41, quinoa: 0.85,
  ketchup: 1.14, mustard: 1.05, mayonnaise: 0.91, 'soy sauce': 1.15, vinegar: 1.01,
  'peanut butter': 1.09, 'tomato sauce': 1.05, 'tomato paste': 1.1, broth: 1.0, stock: 1.0,
};

// grams per single unit (for count <-> weight)
const PER_EACH: Record<string, number> = {
  egg: 50, eggs: 50, 'garlic clove': 3, garlic: 3, clove: 3,
  onion: 110, 'red onion': 110, shallot: 30, tomato: 123, potato: 170, carrot: 61,
  lemon: 100, lime: 67, orange: 130, banana: 118, apple: 180, 'bell pepper': 120,
  pepper: 120, jalapeno: 14, cucumber: 200, zucchini: 200, avocado: 200, 'green onion': 15,
};

const force = process.argv.includes('--force');
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

// Match if a key is the whole name or appears as a whole word inside it.
function lookup(name: string, table: Record<string, number>): number | undefined {
  if (table[name] != null) return table[name];
  for (const key of Object.keys(table).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(^| )${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
    if (re.test(name)) return table[key];
  }
  return undefined;
}

async function main() {
  const items = await prisma.canonicalItem.findMany({
    select: { id: true, name: true, gramsPerMl: true, gramsPerEach: true },
  });
  let ml = 0;
  let each = 0;
  for (const it of items) {
    const n = norm(it.name);
    const data: { gramsPerMl?: number; gramsPerEach?: number } = {};
    const d = lookup(n, DENSITY);
    const e = lookup(n, PER_EACH);
    if (d != null && (force || it.gramsPerMl == null)) data.gramsPerMl = d;
    if (e != null && (force || it.gramsPerEach == null)) data.gramsPerEach = e;
    if (!Object.keys(data).length) continue;
    if (data.gramsPerMl != null) ml++;
    if (data.gramsPerEach != null) each++;
    await prisma.canonicalItem.update({ where: { id: it.id }, data });
  }
  console.log(`Set density on ${ml} item(s), per-each weight on ${each} item(s)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
