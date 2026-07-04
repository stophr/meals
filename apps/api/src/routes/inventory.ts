import type { FastifyInstance } from 'fastify';
import { prisma } from '@meals/db';
import {
  inventoryCreateSchema,
  inventoryUpdateSchema,
  inventoryConsumeSchema,
  pantryExtractSchema,
  pantryBulkAddSchema,
} from '@meals/shared';
import { toBaseQuantity, dimensionOf, parseIngredientLine } from '@meals/core';
import { extractPantryFromText, extractPantryFromImage } from '@meals/ingestion';
import { getHousehold } from '../lib/household.js';
import { consumeFromInventory } from '../lib/inventory.js';
import { resolveCanonicalItem } from '../lib/resolveItem.js';
import { env } from '../env.js';

export async function inventoryRoutes(app: FastifyInstance) {
  app.get('/inventory', async (req) => {
    const household = await getHousehold(req);
    return prisma.inventoryLot.findMany({
      where: { householdId: household.id },
      include: { canonicalItem: true },
      orderBy: [{ expiresAt: 'asc' }, { purchasedAt: 'asc' }],
    });
  });

  app.post('/inventory', async (req, reply) => {
    const data = inventoryCreateSchema.parse(req.body);
    const household = await getHousehold(req);
    reply.code(201);
    return prisma.inventoryLot.create({
      data: {
        householdId: household.id,
        canonicalItemId: data.canonicalItemId,
        quantity: data.quantity.toString(),
        unit: data.unit,
        baseQuantity: toBaseQuantity(data.quantity, data.unit).baseQuantity.toString(),
        brand: data.brand,
        location: data.location,
        purchasedAt: data.purchasedAt,
        expiresAt: data.expiresAt,
      },
    });
  });

  app.patch('/inventory/:id', async (req) => {
    const { id } = req.params as { id: string };
    const data = inventoryUpdateSchema.parse(req.body);
    const patch: Record<string, unknown> = { ...data };
    // Recompute the normalized base quantity whenever the amount OR the unit changes —
    // switching "50 each" to "50 lb" must re-derive baseQuantity, not keep the old count.
    if (data.quantity !== undefined || data.unit !== undefined) {
      const existing = await prisma.inventoryLot.findUniqueOrThrow({ where: { id } });
      const qty = data.quantity ?? Number(existing.quantity);
      const unit = data.unit ?? existing.unit;
      patch.quantity = qty.toString();
      patch.baseQuantity = toBaseQuantity(qty, unit).baseQuantity.toString();
    }
    return prisma.inventoryLot.update({ where: { id }, data: patch });
  });

  app.delete('/inventory/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.inventoryLot.delete({ where: { id } });
    reply.code(204);
  });

  // Extract on-hand items from a description or photo (PREVIEW — nothing written). Video/audio
  // need extra server tooling and return a clear "not enabled" message.
  app.post('/inventory/extract', async (req, reply) => {
    const data = pantryExtractSchema.parse(req.body);
    const textCfg = {
      baseUrl: env.OCR_LOCAL_BASE_URL,
      model: env.LLM_MODEL,
      apiKey: env.OCR_LOCAL_API_KEY || undefined,
    };
    let raw: { name: string; brand: string | null; quantity: number; unit: string }[] = [];
    try {
      if (data.source === 'text') {
        if (!data.text?.trim()) {
          reply.code(400);
          return { message: 'Type what you have (e.g. "2 lb chicken, a dozen eggs, half a bag of rice").' };
        }
        raw = await extractPantryFromText(data.text, textCfg);
      } else if (data.source === 'image') {
        if (!data.dataBase64) {
          reply.code(400);
          return { message: 'Attach a photo of your pantry/fridge/haul.' };
        }
        raw = await extractPantryFromImage(data.dataBase64, data.mediaType ?? 'image/jpeg', {
          ...textCfg,
          model: env.OCR_LOCAL_MODEL,
        });
      } else {
        reply.code(501);
        return {
          message:
            data.source === 'video'
              ? 'Video needs ffmpeg on the server to grab frames — not enabled yet. Snap a photo or type it instead.'
              : 'Audio needs a speech-to-text model (whisper) on the server — not enabled yet. Type it instead.',
        };
      }
    } catch (e) {
      reply.code(502);
      return { message: `Couldn't read that: ${e instanceof Error ? e.message : String(e)}` };
    }
    // Normalize the model's free unit word to a real Unit. US volume words the enum lacks
    // (gallon/quart/pint) are converted to L/ML — which also rescales the quantity.
    const items = raw.map((i) => {
      const w = i.unit.toLowerCase();
      if (/\bgal(lon)?s?\b/.test(w)) return { name: i.name, brand: i.brand, quantity: i.quantity * 3.78541, unit: 'L' };
      if (/\b(qt|quarts?)\b/.test(w)) return { name: i.name, brand: i.brand, quantity: i.quantity * 0.946353, unit: 'L' };
      if (/\b(pt|pints?)\b/.test(w)) return { name: i.name, brand: i.brand, quantity: i.quantity * 473.176, unit: 'ML' };
      return {
        name: i.name,
        brand: i.brand,
        quantity: i.quantity,
        unit: parseIngredientLine(`1 ${i.unit} x`).unit ?? 'EACH',
      };
    });
    return { items };
  });

  // Confirm & write reviewed items as inventory lots.
  app.post('/inventory/bulk-add', async (req, reply) => {
    const { items } = pantryBulkAddSchema.parse(req.body);
    const household = await getHousehold(req);
    let added = 0;
    for (const it of items) {
      const resolved = await resolveCanonicalItem(it.name);
      const base = toBaseQuantity(it.quantity, it.unit);
      await prisma.inventoryLot.create({
        data: {
          householdId: household.id,
          canonicalItemId: resolved.id,
          quantity: it.quantity.toString(),
          unit: it.unit,
          baseQuantity: base.baseQuantity.toString(),
          brand: it.brand ?? undefined,
        },
      });
      added++;
    }
    reply.code(201);
    return { added };
  });

  // Deduct a quantity across lots, FIFO by expiry (used when a meal is cooked).
  app.post('/inventory/consume', async (req) => {
    const data = inventoryConsumeSchema.parse(req.body);
    const household = await getHousehold(req);
    const base = toBaseQuantity(data.quantity, data.unit).baseQuantity;
    return consumeFromInventory(
      household.id,
      data.canonicalItemId,
      base,
      dimensionOf(data.unit),
    );
  });
}
