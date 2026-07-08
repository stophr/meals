import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@meals/db';
import { getHousehold } from '../lib/household.js';
import { env } from '../env.js';

// Safe filename from a UPC/PLU key — must match download-product-images.ts.
const fileFor = (upc: string) => `${upc.replace(/[^a-zA-Z0-9]/g, '_')}.jpg`;

interface CatalogRow {
  upc: string;
  description: string;
  brand: string | null;
  sizeText: string | null;
  imageUrl: string | null;
  imageCached: boolean;
  canonicalItemId: string;
}

export async function catalogRoutes(app: FastifyInstance) {
  // Full-catalog search over the shared Product corpus (trigram-ranked), annotated with the
  // current price at the household's store when we've synced it. Powers browse/add-to-list.
  app.get('/catalog', async (req) => {
    const { q, limit } = req.query as { q?: string; limit?: string };
    const term = (q ?? '').trim().toLowerCase();
    if (term.length < 2) return { items: [] };
    const take = Math.min(Number(limit) || 30, 60);
    const like = `%${term}%`;

    const rows = await prisma.$queryRaw<CatalogRow[]>`
      SELECT upc, description, brand, "sizeText", "imageUrl", "imageCached", "canonicalItemId"
      FROM "Product"
      WHERE lower(description) LIKE ${like} OR lower(coalesce(brand,'')) LIKE ${like}
      ORDER BY similarity(lower(description), ${term}) DESC, length(description) ASC
      LIMIT ${take}`;

    // Prices for these UPCs at the household's linked store(s).
    const household = await getHousehold(req);
    const providers = await prisma.provider.findMany({
      where: { householdId: household.id },
      select: { id: true, name: true, storeLocationId: true },
    });
    const storeLocIds = providers.map((p) => p.storeLocationId).filter((x): x is string => !!x);
    const now = new Date();
    const pps = storeLocIds.length
      ? await prisma.providerProduct.findMany({
          where: { upc: { in: rows.map((r) => r.upc) }, storeLocationId: { in: storeLocIds } },
          include: {
            prices: {
              where: { validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gte: now } }] },
              orderBy: { observedAt: 'desc' },
              take: 1,
            },
          },
        })
      : [];
    const priceByUpc = new Map<string, { price: number; productId: string; providerId: string | null }>();
    for (const pp of pps) {
      const price = pp.prices[0];
      if (!pp.upc || !price) continue;
      const provider = providers.find((p) => p.storeLocationId === pp.storeLocationId);
      priceByUpc.set(pp.upc, { price: Number(price.price), productId: pp.id, providerId: provider?.id ?? null });
    }

    return {
      items: rows.map((r) => {
        const pr = priceByUpc.get(r.upc);
        return {
          upc: r.upc,
          name: r.description,
          brand: r.brand,
          size: r.sizeText,
          image: r.imageUrl, // remote fallback
          imageCached: r.imageCached, // if true, web can use /api/product-images/<upc>
          canonicalItemId: r.canonicalItemId,
          price: pr?.price ?? null,
          priceProductId: pr?.productId ?? null,
        };
      }),
    };
  });

  // Serve a cached medium product image from PRODUCT_IMAGE_DIR. 404 -> client falls back to the
  // remote imageUrl. No auth: product imagery is not sensitive and this is read-only static.
  app.get('/product-images/:upc', async (req, reply) => {
    const { upc } = req.params as { upc: string };
    const path = join(env.PRODUCT_IMAGE_DIR, fileFor(upc.replace(/\.jpg$/i, '')));
    if (!existsSync(path)) {
      reply.code(404);
      return { message: 'no cached image' };
    }
    reply.header('cache-control', 'public, max-age=604800, immutable');
    return reply.type('image/jpeg').send(createReadStream(path));
  });
}
