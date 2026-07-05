import type { FastifyInstance } from 'fastify';
import { prisma } from '@meals/db';
import {
  canonicalItemCreateSchema,
  canonicalItemUpdateSchema,
  itemMergeSchema,
  providerProductCreateSchema,
} from '@meals/shared';
import { buildNormKey, toBaseQuantity } from '@meals/core';
import { getHousehold } from '../lib/household.js';
import { resolveCanonicalItem } from '../lib/resolveItem.js';
import { normalizeUpc } from '../lib/upcUtil.js';
import { resolveProduct } from '../lib/productCorpus.js';

export async function itemRoutes(app: FastifyInstance) {
  // Resolve a phone-scanned barcode against the local UPC corpus, enriching from the most
  // accurate source first (Fry's for description, USDA/OFF for nutrition) on the first scan.
  // Returns the Product (brand/size/nutrition) + its ingredient so the pantry can prefill.
  app.get('/items/barcode/:code', async (req, reply) => {
    const household = await getHousehold(req); // members only; store selection is per-org
    const { code } = req.params as { code: string };
    const upc = normalizeUpc(code);
    if (!upc) {
      reply.code(400);
      return { found: false, message: 'That doesn’t look like a product barcode.' };
    }
    return resolveProduct(upc, household.id);
  });

  // Catalog autocomplete / list. Ranked so an exact/prefix match and popular items surface
  // first — typing "sugar" returns "Sugar" ahead of "Brown Sugar", "Demerara Sugar", etc.
  app.get('/items', async (req) => {
    // Canonical items are a GLOBAL dictionary — the same for every org.
    const { q } = req.query as { q?: string };
    if (!q) {
      return prisma.canonicalItem.findMany({ orderBy: { name: 'asc' }, take: 50 });
    }
    const matches = await prisma.canonicalItem.findMany({
      where: { name: { contains: q, mode: 'insensitive' } },
      take: 200,
    });
    const ids = matches.map((m) => m.id);
    const useRows = ids.length
      ? await prisma.recipeIngredient.groupBy({
          by: ['canonicalItemId'],
          where: { canonicalItemId: { in: ids } },
          _count: true,
        })
      : [];
    const uses = new Map(useRows.map((u) => [u.canonicalItemId as string, u._count]));
    const ql = q.trim().toLowerCase();
    const rank = (name: string) => {
      const n = name.toLowerCase();
      if (n === ql) return 3;
      if (n.startsWith(ql)) return 2;
      if (new RegExp(`\\b${ql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(n)) return 1;
      return 0;
    };
    matches.sort(
      (a, b) =>
        rank(b.name) - rank(a.name) ||
        (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0) ||
        a.name.length - b.name.length ||
        a.name.localeCompare(b.name),
    );
    return matches.slice(0, 50);
  });

  app.post('/items', async (req, reply) => {
    const data = canonicalItemCreateSchema.parse(req.body);
    const base = data.baseUnit ? toBaseQuantity(1, data.baseUnit) : undefined;
    // Resolve via the alias index first so "Pinch Of Sugar" returns the existing "Sugar"
    // instead of spawning another variant.
    const resolved = await resolveCanonicalItem(data.name, {
      category: data.category,
      baseUnit: data.baseUnit,
      baseDimension: base?.dimension,
    });
    reply.code(resolved.created ? 201 : 200);
    return prisma.canonicalItem.findUniqueOrThrow({ where: { id: resolved.id } });
  });

  app.patch('/items/:id', async (req) => {
    const { id } = req.params as { id: string };
    const data = canonicalItemUpdateSchema.parse(req.body);
    return prisma.canonicalItem.update({
      where: { id },
      data: {
        ...data,
        packSize: data.packSize?.toString(),
        ...(data.name ? { normKey: buildNormKey(data.name, data.brand) } : {}),
      },
    });
  });

  app.get('/items/:id/products', async (req) => {
    const { id } = req.params as { id: string };
    return prisma.providerProduct.findMany({
      where: { canonicalItemId: id },
      include: { provider: true },
    });
  });

  app.get('/products/:id/prices', async (req) => {
    const { id } = req.params as { id: string };
    return prisma.priceObservation.findMany({
      where: { providerProductId: id },
      orderBy: { observedAt: 'desc' },
      take: 100,
    });
  });

  // Attach a store listing to (optionally) a canonical item.
  app.post('/products', async (req, reply) => {
    const data = providerProductCreateSchema.parse(req.body);
    const base = data.packSize && data.packUnit ? toBaseQuantity(data.packSize, data.packUnit) : undefined;
    reply.code(201);
    return prisma.providerProduct.create({
      data: {
        providerId: data.providerId,
        canonicalItemId: data.canonicalItemId,
        rawName: data.rawName,
        brand: data.brand,
        sizeText: data.sizeText,
        packSize: data.packSize?.toString(),
        packUnit: data.packUnit,
        baseQuantity: base?.baseQuantity.toString(),
        upc: data.upc,
        plu: data.plu,
        sku: data.sku,
        url: data.url,
      },
    });
  });

  // Merge two canonical items (dedupe): repoint products/recipes/inventory/list items.
  app.post('/items/merge', async (req) => {
    const { sourceItemId, targetItemId } = itemMergeSchema.parse(req.body);
    return prisma.$transaction(async (tx) => {
      await tx.providerProduct.updateMany({ where: { canonicalItemId: sourceItemId }, data: { canonicalItemId: targetItemId } });
      await tx.recipeIngredient.updateMany({ where: { canonicalItemId: sourceItemId }, data: { canonicalItemId: targetItemId } });
      await tx.inventoryLot.updateMany({ where: { canonicalItemId: sourceItemId }, data: { canonicalItemId: targetItemId } });
      await tx.shoppingListItem.updateMany({ where: { canonicalItemId: sourceItemId }, data: { canonicalItemId: targetItemId } });
      await tx.canonicalItem.delete({ where: { id: sourceItemId } });
      return { merged: true, into: targetItemId };
    });
  });
}
