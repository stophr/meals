import type { FastifyInstance } from 'fastify';
import { prisma } from '@meals/db';
import { optimize } from '@meals/core';
import {
  shoppingListCreateSchema,
  shoppingListItemUpdateSchema,
  shoppingListItemAddSchema,
  shopFromQueueSchema,
  archiveSchema,
} from '@meals/shared';
import type { OptimizationResult } from '@meals/shared';
import { toBaseQuantity } from '@meals/core';
import { getHousehold } from '../lib/household.js';
import { buildOptimizerInput } from '../lib/optimizerInput.js';
import { buildShoppingList } from '../lib/shoppingBuild.js';
import { noonToday, lockedDays, dayKey } from '../lib/queue.js';
import { resolveCanonicalItem } from '../lib/resolveItem.js';
import { computeItemOptions, bestOption } from '../lib/shoppingOptions.js';

function dayLabel(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function startOfToday(): Date {
  const d = noonToday();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function shoppingListRoutes(app: FastifyInstance) {
  app.get('/shopping-lists', async (req) => {
    const household = await getHousehold(req);
    const q = req.query as { archived?: string };
    // Auto-archive any list whose covered horizon is now in the past.
    await prisma.shoppingList.updateMany({
      where: {
        householdId: household.id,
        archivedAt: null,
        coverageEnd: { not: null, lt: startOfToday() },
      },
      data: { archivedAt: new Date() },
    });
    const wantArchived = q.archived === 'true' || q.archived === '1';
    return prisma.shoppingList.findMany({
      where: { householdId: household.id, archivedAt: wantArchived ? { not: null } : null },
      orderBy: { createdAt: 'desc' },
    });
  });

  // Upcoming days for the "going to the store" picker: each day with its queued meals and
  // whether it's already locked by a prior (active) list — locked days can't be re-selected.
  app.get('/shopping-lists/upcoming-days', async (req) => {
    const household = await getHousehold(req);
    const horizon = Math.min(60, Math.max(1, Number((req.query as { days?: string }).days ?? 21)));
    const start = startOfToday();
    const end = new Date(start.getTime() + horizon * 86_400_000 - 1);
    const [entries, locks] = await Promise.all([
      prisma.mealPlanEntry.findMany({
        where: { mealPlan: { householdId: household.id }, date: { gte: start, lte: end } },
        include: { recipe: { select: { name: true } } },
        orderBy: { date: 'asc' },
      }),
      lockedDays(household.id),
    ]);
    const byDay = new Map<string, { date: string; locked: boolean; meals: string[] }>();
    for (let i = 0; i < horizon; i++) {
      const d = new Date(start.getTime() + i * 86_400_000);
      const key = dayKey(d);
      byDay.set(key, { date: key, locked: locks.has(key), meals: [] });
    }
    for (const e of entries) {
      const key = dayKey(e.date!);
      byDay.get(key)?.meals.push(e.recipe.name);
    }
    // Only surface days that actually have meals to shop for.
    return { days: [...byDay.values()].filter((d) => d.meals.length > 0) };
  });

  app.get('/shopping-lists/:id', async (req) => {
    const { id } = req.params as { id: string };
    return prisma.shoppingList.findUniqueOrThrow({
      where: { id },
      include: { items: { include: { canonicalItem: true } } },
    });
  });

  app.post('/shopping-lists', async (req, reply) => {
    const data = shoppingListCreateSchema.parse(req.body);
    const household = await getHousehold(req);
    reply.code(201);
    return prisma.shoppingList.create({
      data: { householdId: household.id, name: data.name, mealPlanId: data.mealPlanId },
    });
  });

  // "I'm going to the grocery store": build a list from the next N days of queued meals
  // (skipping meals already bought for), then LOCK those days.
  app.post('/shopping-lists/from-queue', async (req, reply) => {
    const { days, dates } = shopFromQueueSchema.parse(req.body ?? {});
    const household = await getHousehold(req);
    const locks = await lockedDays(household.id);

    // Chosen day-keys: explicit picks (day-picker) or the next N days. Locked days dropped.
    let dayKeys: string[];
    if (dates && dates.length) {
      dayKeys = dates.map((d) => dayKey(new Date(d)));
    } else {
      const s = startOfToday();
      dayKeys = Array.from({ length: days }, (_, i) => dayKey(new Date(s.getTime() + i * 86_400_000)));
    }
    const wanted = new Set(dayKeys.filter((k) => !locks.has(k)));
    if (!wanted.size) {
      reply.code(422);
      return { message: 'No selectable days — pick at least one unlocked day with meals.' };
    }

    const sorted = [...wanted].sort();
    const rangeStart = new Date(`${sorted[0]}T00:00:00`);
    const rangeEnd = new Date(`${sorted[sorted.length - 1]}T23:59:59`);
    const entries = (
      await prisma.mealPlanEntry.findMany({
        where: {
          mealPlan: { householdId: household.id },
          date: { gte: rangeStart, lte: rangeEnd },
          lockedByListId: null,
        },
        include: { recipe: { include: { ingredients: { include: { canonicalItem: true } } } } },
      })
    ).filter((e) => wanted.has(dayKey(e.date!))); // exact chosen days only (non-contiguous safe)

    if (!entries.length) {
      reply.code(422);
      return { message: 'No unlocked meals on the selected day(s) — add meals to the queue first.' };
    }

    const list = await buildShoppingList(household.id, entries, {
      name: `Shop ${dayLabel(rangeStart)} – ${dayLabel(rangeEnd)}`,
      coverageStart: rangeStart,
      coverageEnd: new Date(`${sorted[sorted.length - 1]}T00:00:00`),
    });
    await prisma.mealPlanEntry.updateMany({
      where: { id: { in: entries.map((e) => e.id) } },
      data: { lockedByListId: list.id },
    });
    reply.code(201);
    return { ...list, lockedMeals: entries.length, coverageDays: wanted.size };
  });

  // Archive / unarchive a list (clears Shop UI without deleting).
  app.post('/shopping-lists/:id/archive', async (req) => {
    const { id } = req.params as { id: string };
    const { archived } = archiveSchema.parse(req.body ?? {});
    return prisma.shoppingList.update({
      where: { id },
      data: { archivedAt: archived ? new Date() : null },
    });
  });

  // Add a one-off item by name (resolved to a canonical item via the alias index).
  app.post('/shopping-lists/:id/items', async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = shoppingListItemAddSchema.parse(req.body);
    const household = await getHousehold(req);
    const resolved = await resolveCanonicalItem(data.name);
    const base = toBaseQuantity(data.quantity, data.unit);
    reply.code(201);
    return prisma.shoppingListItem.create({
      data: {
        shoppingListId: id,
        canonicalItemId: resolved.id,
        quantityNeeded: data.quantity.toString(),
        unit: data.unit,
        baseQuantityNeeded: base.baseQuantity.toString(),
      },
      include: { canonicalItem: true },
    });
  });

  // Run the time-vs-savings optimizer, persist the result, and pre-assign each item to the
  // recommended option's store/product.
  app.post('/shopping-lists/:id/optimize', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { timeValue?: string; maxStores?: string };
    const household = await getHousehold(req);

    const timeValue = q.timeValue ? Number(q.timeValue) : Number(household.timeValuePerMinute);
    const maxStores = q.maxStores ? Number(q.maxStores) : undefined;

    const { input } = await buildOptimizerInput(id, household.id, timeValue, maxStores);
    const result: OptimizationResult = optimize(input);

    const recommended = result.options[result.recommendedIndex];
    await prisma.$transaction(async (tx) => {
      await tx.shoppingList.update({
        where: { id },
        data: { status: 'optimized', optimizationResult: result as unknown as object },
      });
      if (recommended) {
        for (const a of recommended.assignments) {
          await tx.shoppingListItem.update({
            where: { id: a.itemId },
            data: {
              assignedProviderId: a.providerId,
              chosenProductId: a.productId,
              estimatedPrice: a.cost.toFixed(2),
            },
          });
        }
      }
    });

    return result;
  });

  app.patch('/shopping-lists/:id/items/:itemId', async (req) => {
    const { itemId } = req.params as { itemId: string };
    const data = shoppingListItemUpdateSchema.parse(req.body);
    const patch: Record<string, unknown> = {
      assignedProviderId: data.assignedProviderId,
      chosenProductId: data.chosenProductId,
      status: data.status,
    };
    // Changing the needed amount/unit re-derives the normalized base quantity.
    if (data.quantity !== undefined || data.unit !== undefined) {
      const existing = await prisma.shoppingListItem.findUniqueOrThrow({ where: { id: itemId } });
      const qty = data.quantity ?? Number(existing.quantityNeeded);
      const unit = data.unit ?? existing.unit;
      patch.quantityNeeded = qty.toString();
      patch.unit = unit;
      patch.baseQuantityNeeded = toBaseQuantity(qty, unit).baseQuantity.toString();
    }
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
    return prisma.shoppingListItem.update({ where: { id: itemId }, data: patch });
  });

  app.delete('/shopping-lists/:id/items/:itemId', async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    const household = await getHousehold(req);
    await prisma.shoppingListItem.deleteMany({
      where: { id: itemId, shoppingList: { id, householdId: household.id } },
    });
    reply.code(204);
  });

  // Per-item provider options (every store × size with a current price).
  app.get('/shopping-lists/:id/options', async (req) => {
    const { id } = req.params as { id: string };
    const household = await getHousehold(req);
    return { items: await computeItemOptions(household.id, id) };
  });

  // Swap the product for a list item on the fly — pick one of its options (`productId`) or scan a
  // UPC. Sets the chosen product + price, and remembers the brand as the standing preference.
  app.post('/shopping-lists/:id/items/:itemId/substitute', async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    const household = await getHousehold(req);
    const body = (req.body ?? {}) as { productId?: string; upc?: string };
    const item = await prisma.shoppingListItem.findFirstOrThrow({
      where: { id: itemId, shoppingList: { id, householdId: household.id } },
      select: { canonicalItemId: true },
    });
    const saveBrand = (brand: string) =>
      prisma.brandPreference.upsert({
        where: { householdId_canonicalItemId: { householdId: household.id, canonicalItemId: item.canonicalItemId } },
        create: { householdId: household.id, canonicalItemId: item.canonicalItemId, brand },
        update: { brand },
      });

    const opts = (await computeItemOptions(household.id, id)).find((i) => i.itemId === itemId)?.options ?? [];
    let chosen = body.productId ? opts.find((o) => o.productId === body.productId) : undefined;

    if (!chosen && body.upc) {
      const code = body.upc.replace(/\D/g, '');
      const pp = await prisma.providerProduct.findFirst({
        where: { upc: code, canonicalItemId: item.canonicalItemId, provider: { householdId: household.id } },
        select: { id: true },
      });
      chosen = pp ? opts.find((o) => o.productId === pp.id) : undefined;
      if (!chosen) {
        // Scanned a product we don't stock — still learn the brand for next time.
        const corpus = await prisma.product.findUnique({ where: { upc: code }, select: { brand: true } });
        if (corpus?.brand) {
          await saveBrand(corpus.brand);
          return { updated: false, savedBrand: corpus.brand, message: `Saved “${corpus.brand}” as your preference — no price for it at your stores yet.` };
        }
        reply.code(404);
        return { updated: false, message: 'That product isn’t stocked at your stores.' };
      }
    }
    if (!chosen) {
      reply.code(400);
      return { updated: false, message: 'Provide a productId or a upc.' };
    }

    await prisma.shoppingListItem.update({
      where: { id: itemId },
      data: {
        chosenProductId: chosen.productId,
        assignedProviderId: chosen.providerId,
        estimatedPrice: chosen.totalCost.toFixed(2),
      },
    });
    if (chosen.brand) await saveBrand(chosen.brand);
    return { updated: true, brand: chosen.brand, price: chosen.totalCost, provider: chosen.providerName };
  });

  // Standing brand preferences for this org (manage in settings).
  app.get('/brand-preferences', async (req) => {
    const household = await getHousehold(req);
    const rows = await prisma.brandPreference.findMany({
      where: { householdId: household.id },
      include: { canonicalItem: { select: { name: true } } },
      orderBy: { canonicalItem: { name: 'asc' } },
    });
    return rows.map((r) => ({ id: r.id, canonicalItemId: r.canonicalItemId, item: r.canonicalItem.name, brand: r.brand }));
  });

  app.delete('/brand-preferences/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const household = await getHousehold(req);
    await prisma.brandPreference.deleteMany({ where: { id, householdId: household.id } });
    reply.code(204);
  });

  // Set the price mode (cheapest total vs cheapest per-unit) and re-pick the store for the
  // whole list, or a single item when `itemId` is given. Selecting 'total' is also how you
  // revert. Persists priceMode + the chosen product so Build/Cart honor it.
  app.post('/shopping-lists/:id/auto-select', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { mode?: string; itemId?: string } | null;
    const mode = (body?.mode === 'unit' ? 'unit' : 'total') as 'unit' | 'total';
    const household = await getHousehold(req);
    const all = await computeItemOptions(household.id, id);
    const targets = body?.itemId ? all.filter((i) => i.itemId === body.itemId) : all;

    let selected = 0;
    await prisma.$transaction(
      targets.map((it) => {
        const best = bestOption(it.options, mode, it.preferredBrand);
        if (best) selected++;
        return prisma.shoppingListItem.update({
          where: { id: it.itemId },
          data: {
            priceMode: mode,
            ...(best
              ? {
                  assignedProviderId: best.providerId,
                  chosenProductId: best.productId,
                  estimatedPrice: best.totalCost.toFixed(2),
                }
              : {}),
          },
        });
      }),
    );
    return { mode, scope: body?.itemId ? 'item' : 'all', selected, unpriced: targets.length - selected };
  });

  // Split the list per store, with totals and whether each store supports cart fill.
  app.post('/shopping-lists/:id/build', async (req) => {
    const { id } = req.params as { id: string };
    const household = await getHousehold(req);
    const items = await computeItemOptions(household.id, id);
    const providers = await prisma.provider.findMany({ where: { householdId: household.id } });
    const krogerToken = await prisma.integrationToken.findUnique({
      where: { householdId_kind: { householdId: household.id, kind: 'kroger' } },
    });

    const groups = new Map<
      string,
      { providerId: string; name: string; canFillCart: boolean; total: number; items: unknown[] }
    >();
    const unpriced: string[] = [];

    for (const item of items) {
      // Use the chosen option; fall back to cheapest total if nothing chosen yet.
      const chosen =
        item.options.find((o) => o.productId === item.chosenProductId) ?? item.options[0];
      if (!chosen) {
        unpriced.push(item.name);
        continue;
      }
      const provider = providers.find((p) => p.id === chosen.providerId);
      const integ = provider?.integration as { type?: string } | null;
      let g = groups.get(chosen.providerId);
      if (!g) {
        g = {
          providerId: chosen.providerId,
          name: chosen.providerName,
          canFillCart: integ?.type === 'kroger' && !!krogerToken,
          total: 0,
          items: [],
        };
        groups.set(chosen.providerId, g);
      }
      g.total = Math.round((g.total + chosen.totalCost) * 100) / 100;
      g.items.push({
        name: item.name,
        brand: chosen.brand,
        size: chosen.size,
        packsNeeded: chosen.packsNeeded,
        totalCost: chosen.totalCost,
      });
    }

    const stores = [...groups.values()].sort((a, b) => b.total - a.total);
    return {
      stores,
      grandTotal: Math.round(stores.reduce((s, g) => s + g.total, 0) * 100) / 100,
      unpriced,
    };
  });

  app.delete('/shopping-lists/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.shoppingList.delete({ where: { id } });
    reply.code(204);
  });
}
