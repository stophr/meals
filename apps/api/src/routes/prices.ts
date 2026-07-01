import type { FastifyInstance } from 'fastify';
import { prisma, PriceSource } from '@meals/db';
import { priceCreateSchema, priceUpdateSchema } from '@meals/shared';

export async function priceRoutes(app: FastifyInstance) {
  // Manual price entry — the base data path that OCR/scrapers also write into.
  app.post('/prices', async (req, reply) => {
    const data = priceCreateSchema.parse(req.body);
    const product = await prisma.providerProduct.findUniqueOrThrow({
      where: { id: data.providerProductId },
    });
    const packBase = product.baseQuantity ? Number(product.baseQuantity) : 0;
    const pricePerBaseUnit = packBase > 0 ? (data.price / packBase).toFixed(6) : undefined;

    reply.code(201);
    return prisma.priceObservation.create({
      data: {
        providerProductId: data.providerProductId,
        price: data.price.toFixed(2),
        pricePerBaseUnit,
        currency: data.currency,
        isDeal: data.isDeal,
        dealType: data.dealType,
        multiBuyQty: data.multiBuyQty,
        multiBuyPrice: data.multiBuyPrice?.toFixed(2),
        regularPrice: data.regularPrice?.toFixed(2),
        validFrom: data.validFrom,
        validTo: data.validTo,
        source: PriceSource.MANUAL,
      },
    });
  });

  app.patch('/prices/:id', async (req) => {
    const { id } = req.params as { id: string };
    const data = priceUpdateSchema.parse(req.body);
    return prisma.priceObservation.update({
      where: { id },
      data: {
        price: data.price?.toFixed(2),
        currency: data.currency,
        isDeal: data.isDeal,
        dealType: data.dealType,
        multiBuyQty: data.multiBuyQty,
        multiBuyPrice: data.multiBuyPrice?.toFixed(2),
        regularPrice: data.regularPrice?.toFixed(2),
        validFrom: data.validFrom,
        validTo: data.validTo,
      },
    });
  });

  app.delete('/prices/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.priceObservation.delete({ where: { id } });
    reply.code(204);
  });
}
