import type { FastifyInstance } from 'fastify';
import { prisma, PriceSource } from '@meals/db';
import {
  providerCreateSchema,
  providerUpdateSchema,
  quickPriceSchema,
  bulkPricesSchema,
} from '@meals/shared';
import { parseIngredientLine, toBaseQuantity } from '@meals/core';
import { getHousehold } from '../lib/household.js';
import { recordProviderPrices } from '../lib/costcoPrices.js';

export async function providerRoutes(app: FastifyInstance) {
  app.get('/providers', async () => {
    const household = await getHousehold();
    return prisma.provider.findMany({ where: { householdId: household.id }, orderBy: { name: 'asc' } });
  });

  app.post('/providers', async (req, reply) => {
    const data = providerCreateSchema.parse(req.body);
    const household = await getHousehold();
    reply.code(201);
    return prisma.provider.create({ data: { ...data, householdId: household.id } });
  });

  app.patch('/providers/:id', async (req) => {
    const { id } = req.params as { id: string };
    const data = providerUpdateSchema.parse(req.body);
    return prisma.provider.update({ where: { id }, data });
  });

  app.delete('/providers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.provider.delete({ where: { id } });
    reply.code(204);
  });

  // Mobile quick price capture: record the price the user just saw at a store for one item.
  // One "manual" product per item per provider; optional size enables proportional costing.
  app.post('/providers/:id/quick-price', async (req) => {
    const { id } = req.params as { id: string };
    const { canonicalItemId, price, size, brand } = quickPriceSchema.parse(req.body);
    const item = await prisma.canonicalItem.findUniqueOrThrow({ where: { id: canonicalItemId } });
    const parsed = size ? parseIngredientLine(size) : null;
    const base =
      parsed?.quantity && parsed.unit ? toBaseQuantity(parsed.quantity, parsed.unit) : null;

    const upc = `manual:${canonicalItemId}`;
    const product = await prisma.providerProduct.upsert({
      where: { providerId_upc: { providerId: id, upc } },
      create: {
        providerId: id,
        canonicalItemId,
        rawName: item.name,
        brand,
        sizeText: size,
        baseQuantity: base ? base.baseQuantity.toString() : undefined,
        upc,
      },
      update: {
        brand,
        sizeText: size,
        baseQuantity: base ? base.baseQuantity.toString() : undefined,
      },
    });
    await prisma.priceObservation.create({
      data: {
        providerProductId: product.id,
        price: price.toFixed(2),
        pricePerBaseUnit:
          base && base.baseQuantity > 0 ? (price / base.baseQuantity).toFixed(6) : undefined,
        source: PriceSource.MANUAL,
        validTo: new Date(Date.now() + 60 * 86_400_000),
      },
    });
    return { ok: true };
  });

  // Save parsed/edited price rows (from the free-form LLM paste) to this provider.
  app.post('/providers/:id/bulk-prices', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { items } = bulkPricesSchema.parse(req.body);
    const household = await getHousehold();
    try {
      const res = await recordProviderPrices(household.id, id, items, {
        source: PriceSource.MANUAL,
        upcPrefix: 'paste',
      });
      return res;
    } catch (err) {
      reply.code(400);
      return { message: err instanceof Error ? err.message : String(err) };
    }
  });
}
