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

export async function itemRoutes(app: FastifyInstance) {
  // Catalog autocomplete / list.
  app.get('/items', async (req) => {
    const household = await getHousehold();
    const { q } = req.query as { q?: string };
    return prisma.canonicalItem.findMany({
      where: {
        householdId: household.id,
        ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
      },
      orderBy: { name: 'asc' },
      take: 50,
    });
  });

  app.post('/items', async (req, reply) => {
    const data = canonicalItemCreateSchema.parse(req.body);
    const household = await getHousehold();
    const base = data.baseUnit ? toBaseQuantity(1, data.baseUnit) : undefined;
    reply.code(201);
    return prisma.canonicalItem.create({
      data: {
        householdId: household.id,
        name: data.name,
        brand: data.brand,
        category: data.category,
        packSize: data.packSize?.toString(),
        packUnit: data.packUnit,
        baseUnit: data.baseUnit,
        baseDimension: base?.dimension,
        recipeUnit: data.recipeUnit,
        purchaseUnit: data.purchaseUnit,
        normKey: buildNormKey(data.name, data.brand),
      },
    });
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
