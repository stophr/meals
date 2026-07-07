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
import { resolveProduct, resolvePluProduct, mapGtinToPlu } from '../lib/productCorpus.js';
import { extractPlu, resolvePlu, extractProduceLabel, extractProduceLabelClaude } from '@meals/ingestion';
import { readProduceLabelPaddle } from '../lib/produceOcr.js';
import { env } from '../env.js';

// Do a produce commodity name (from a PLU) and a vision-read label name refer to the same thing?
// Used to catch digit misreads (4012→4011 turns "Navel" into "Bananas").
const LABEL_STOP = new Set(['large', 'small', 'medium', 'organic', 'fresh', 'each', 'with', 'baby', 'mini']);
function labelSharesWord(a: string, b: string): boolean {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z ]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !LABEL_STOP.has(w))
        .map((w) => w.replace(/s$/, '')),
    );
  const A = words(a);
  const B = words(b);
  for (const w of A) if (B.has(w)) return true;
  return false;
}

export async function itemRoutes(app: FastifyInstance) {
  // Resolve a scanned/typed code against the local corpus. A produce PLU (typed 4-5 digits, or a
  // GS1 DataBar that embeds one) maps to a generic commodity (IFPS) + USDA nutrition; an 8-14
  // digit UPC/EAN enriches from the most accurate source first (Fry's desc, USDA/OFF nutrition).
  // PLU is checked first because a produce DataBar also passes the UPC length test.
  app.get('/items/barcode/:code', async (req, reply) => {
    const household = await getHousehold(req); // members only; store selection is per-org
    const { code } = req.params as { code: string };
    const plu = extractPlu(code);
    if (plu) return resolvePluProduct(plu.code, household.id);
    const upc = normalizeUpc(code);
    if (upc) return resolveProduct(upc, household.id);
    reply.code(400);
    return { found: false, message: 'That doesn’t look like a product barcode or produce PLU.' };
  });

  // Learn a GTIN -> PLU mapping: when a scanned produce barcode (e.g. a branded GTIN) resolves to
  // nothing, the app asks for the 4-5 digit PLU on the sticker; we remember it so the next scan
  // of that GTIN resolves to the produce commodity + nutrition.
  app.post('/items/map-plu', async (req, reply) => {
    await getHousehold(req);
    const { gtin, plu } = (req.body ?? {}) as { gtin?: string; plu?: string };
    const g = normalizeUpc(gtin ?? '');
    const pluDigits = (plu ?? '').replace(/\D/g, '');
    if (!g) {
      reply.code(400);
      return { found: false, message: 'Invalid barcode.' };
    }
    if (!/^\d{4,5}$/.test(pluDigits)) {
      reply.code(400);
      return { found: false, message: 'Enter the 4–5 digit PLU from the sticker.' };
    }
    return mapGtinToPlu(g, pluDigits);
  });

  // Read a captured camera frame with a vision LLM (for produce stickers whose tiny DataBar won't
  // decode in-browser — the printed PLU/name reads fine). Returns a `code` (PLU preferred, else a
  // printed UPC) to feed the normal barcode-resolve pipeline, plus what was read.
  app.post('/items/scan-image', async (req, reply) => {
    await getHousehold(req);
    const { imageBase64, mediaType } = (req.body ?? {}) as { imageBase64?: string; mediaType?: string };
    if (!imageBase64) {
      reply.code(400);
      return { code: null, message: 'No image provided.' };
    }
    const mt = mediaType ?? 'image/jpeg';
    let label: { plu: string | null; upc: string | null; name: string | null; organic: boolean } | null = null;
    let via = 'paddleocr';

    // 1) PaddleOCR + IFPS table — fast, precise on digits, cross-checks the PLU against the name.
    try {
      const p = await readProduceLabelPaddle(imageBase64);
      if (p?.plu) label = p;
    } catch {
      /* sidecar down or no PLU — fall back to the vision LLM */
    }

    // 2) Vision LLM fallback (Claude when a key is set, else the local model).
    if (!label) {
      via = env.ANTHROPIC_API_KEY ? 'claude' : 'local-vlm';
      try {
        label = env.ANTHROPIC_API_KEY
          ? await extractProduceLabelClaude(imageBase64, mt, { apiKey: env.ANTHROPIC_API_KEY, model: env.OCR_MODEL })
          : await extractProduceLabel(imageBase64, mt, {
              baseUrl: env.OCR_LOCAL_BASE_URL,
              model: env.OCR_LOCAL_MODEL,
              apiKey: env.OCR_LOCAL_API_KEY || undefined,
            });
      } catch (e) {
        reply.code(502);
        return { code: null, message: `Couldn’t read the label: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    const pluCode = label.plu
      ? label.organic && label.plu.length === 4
        ? `9${label.plu}`
        : label.plu
      : null;

    // Sanity: if we read both a PLU and a name and they disagree (a misread digit), don't trust
    // the PLU — ask the user to type it rather than silently adding the wrong produce.
    if (pluCode && label.name) {
      const commodity = resolvePlu(pluCode)?.commodity ?? '';
      if (commodity && !labelSharesWord(commodity, label.name)) {
        return {
          code: null,
          ...label,
          via,
          mismatch: true,
          message: `Read “${label.name}” but the PLU (${label.plu}) didn’t match it — type the 4-digit PLU from the sticker.`,
        };
      }
    }

    const code = pluCode ?? label.upc;
    return { code: code ?? null, ...label, via };
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
      include: { storeLocation: true },
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
    const provider = await prisma.provider.findUniqueOrThrow({ where: { id: data.providerId } });
    if (!provider.storeLocationId) throw new Error('Provider has no store-location corpus');
    const base = data.packSize && data.packUnit ? toBaseQuantity(data.packSize, data.packUnit) : undefined;
    reply.code(201);
    return prisma.providerProduct.create({
      data: {
        storeLocationId: provider.storeLocationId,
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
