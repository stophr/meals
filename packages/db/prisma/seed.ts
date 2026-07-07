// Dev seed: one household, two stores with travel times, three canonical items each
// stocked (and priced) at both stores, and one recipe. Enough to exercise
// meal-plan -> generate-list -> optimize end to end.

import { PrismaClient, Unit, UnitDimension, PriceSource } from '../generated/client/index.js';

const prisma = new PrismaClient();

async function main() {
  // Idempotent-ish: wipe household-scoped data for a clean reseed in dev.
  await prisma.household.deleteMany({ where: { name: 'Demo Household' } });

  const household = await prisma.household.create({
    data: {
      name: 'Demo Household',
      homeLat: 45.42,
      homeLng: -75.7,
      currency: 'USD',
      timeValuePerMinute: '0.25',
      users: {
        create: { email: 'owner@example.com', displayName: 'Owner', role: 'owner' },
      },
    },
  });

  // Each seed store gets its own shared StoreLocation corpus (products/prices attach here).
  async function makeStore(name: string, travelMinutes: number, travelKm: number) {
    const loc = await prisma.storeLocation.create({
      data: { locationKey: `seed:${name}`, chain: 'manual', name },
    });
    return prisma.provider.create({
      data: { householdId: household.id, name, travelMinutes, travelKm, storeLocationId: loc.id },
    });
  }
  const megamart = await makeStore('MegaMart', 10, 4);
  const freshfarm = await makeStore('FreshFarm', 25, 12);

  // canonical item + a product at each store + a current price.
  async function stockItem(opts: {
    name: string;
    brand?: string;
    category: string;
    baseUnit: Unit;
    baseDimension: UnitDimension;
    packSize: number;
    packUnit: Unit;
    baseQuantity: number; // pack expressed in base units
    normKey: string;
    priceMega: number;
    priceFresh: number;
  }) {
    const item = await prisma.canonicalItem.create({
      data: {
        name: opts.name,
        brand: opts.brand,
        category: opts.category,
        baseUnit: opts.baseUnit,
        baseDimension: opts.baseDimension,
        packSize: String(opts.packSize),
        packUnit: opts.packUnit,
        normKey: opts.normKey,
      },
    });

    for (const [provider, price] of [
      [megamart, opts.priceMega] as const,
      [freshfarm, opts.priceFresh] as const,
    ]) {
      const product = await prisma.providerProduct.create({
        data: {
          storeLocationId: provider.storeLocationId!,
          canonicalItemId: item.id,
          rawName: `${opts.brand ?? ''} ${opts.name}`.trim(),
          brand: opts.brand,
          sizeText: `${opts.packSize} ${opts.packUnit}`,
          packSize: String(opts.packSize),
          packUnit: opts.packUnit,
          baseQuantity: String(opts.baseQuantity),
        },
      });
      await prisma.priceObservation.create({
        data: {
          providerProductId: product.id,
          price: price.toFixed(2),
          pricePerBaseUnit: (price / opts.baseQuantity).toFixed(6),
          source: PriceSource.MANUAL,
        },
      });
    }
    return item;
  }

  const milk = await stockItem({
    name: 'Milk 2%',
    category: 'dairy',
    baseUnit: Unit.ML,
    baseDimension: UnitDimension.VOLUME,
    packSize: 1,
    packUnit: Unit.L,
    baseQuantity: 3785, // 1 gal
    normKey: 'milk 2%',
    priceMega: 3.5,
    priceFresh: 2.9,
  });
  const eggs = await stockItem({
    name: 'Eggs Large',
    category: 'dairy',
    baseUnit: Unit.EACH,
    baseDimension: UnitDimension.COUNT,
    packSize: 12,
    packUnit: Unit.EACH,
    baseQuantity: 12,
    normKey: 'eggs large',
    priceMega: 4.0,
    priceFresh: 3.2,
  });
  const flour = await stockItem({
    name: 'All-Purpose Flour',
    category: 'baking',
    baseUnit: Unit.G,
    baseDimension: UnitDimension.MASS,
    packSize: 2,
    packUnit: Unit.KG,
    baseQuantity: 2000,
    normKey: 'all-purpose flour',
    priceMega: 2.0,
    priceFresh: 5.0,
  });

  await prisma.recipe.create({
    data: {
      householdId: household.id,
      name: 'Simple Pancakes',
      servings: 4,
      prepMinutes: 20,
      instructions: 'Mix, whisk, cook on griddle.',
      cuisine: 'American',
      category: 'Breakfast',
      tags: ['quick', 'kid-friendly'],
      complexity: 'EASY',
      ingredients: {
        create: [
          { canonicalItemId: flour.id, quantity: '300', unit: Unit.G, baseQuantity: '300' },
          { canonicalItemId: milk.id, quantity: '500', unit: Unit.ML, baseQuantity: '500' },
          { canonicalItemId: eggs.id, quantity: '2', unit: Unit.EACH, baseQuantity: '2' },
        ],
      },
    },
  });

  console.log(`Seeded household ${household.id} with 2 providers, 3 items, 1 recipe.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
