import type { FastifyInstance } from 'fastify';
import { prisma, JobType, JobStatus, PriceSource } from '@meals/db';
import { extractReceipt, supportedMediaTypes } from '@meals/ingestion';
import type { ReceiptMediaType } from '@meals/ingestion';
import { matchLine, normalizeName } from '@meals/core';
import { reviewResolveSchema } from '@meals/shared';
import { getHousehold } from '../lib/household.js';
import { env } from '../env.js';

export async function ingestRoutes(app: FastifyInstance) {
  // Receipt upload -> OCR job -> extraction lines with match suggestions (run inline for MVP;
  // Phase 2 moves this to a queue with SSE progress).
  app.post('/ingest/receipt', async (req, reply) => {
    // Validate the selected provider is configured before doing any work.
    if (env.OCR_PROVIDER === 'local' && !env.OCR_LOCAL_BASE_URL) {
      reply.code(503);
      return { message: 'OCR unavailable: OCR_LOCAL_BASE_URL not configured' };
    }
    if (env.OCR_PROVIDER === 'claude' && !env.ANTHROPIC_API_KEY) {
      reply.code(503);
      return { message: 'OCR unavailable: ANTHROPIC_API_KEY not configured' };
    }
    const household = await getHousehold(req);

    // Collect the uploaded file + providerId field from the multipart body.
    let providerId: string | undefined;
    let buffer: Buffer | undefined;
    let mimetype = 'image/jpeg';
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        buffer = await part.toBuffer();
        mimetype = part.mimetype;
      } else if (part.fieldname === 'providerId') {
        providerId = String(part.value);
      }
    }
    if (!buffer) {
      reply.code(400);
      return { message: 'No file uploaded' };
    }
    const mediaType: ReceiptMediaType = (supportedMediaTypes as readonly string[]).includes(mimetype)
      ? (mimetype as ReceiptMediaType)
      : 'image/jpeg';

    const job = await prisma.ingestionJob.create({
      data: { householdId: household.id, type: JobType.OCR_RECEIPT, status: JobStatus.RUNNING, providerId },
    });

    try {
      const { receipt, confidence, modelUsed } = await extractReceipt({
        imageBase64: buffer.toString('base64'),
        mediaType,
        provider: env.OCR_PROVIDER,
        local: {
          baseUrl: env.OCR_LOCAL_BASE_URL,
          model: env.OCR_LOCAL_MODEL,
          apiKey: env.OCR_LOCAL_API_KEY || undefined,
        },
        claude: {
          apiKey: env.ANTHROPIC_API_KEY,
          model: env.OCR_MODEL,
          escalationModel: env.OCR_ESCALATION_MODEL,
        },
      });

      // Build match candidates from the provider's known products.
      const candidates = providerId
        ? (
            await prisma.providerProduct.findMany({ where: { providerId } })
          ).map((p) => ({ productId: p.id, text: `${p.brand ?? ''} ${p.rawName}`.trim() }))
        : [];

      await prisma.$transaction(
        receipt.lines.map((line) => {
          const match = candidates.length ? matchLine(line.rawName, candidates) : null;
          return prisma.extractionLine.create({
            data: {
              jobId: job.id,
              rawName: line.rawName,
              quantity: line.quantity?.toString(),
              unit: line.unit,
              unitPrice: line.unitPrice?.toString(),
              totalPrice: line.totalPrice?.toString(),
              matchProductId: match?.productId ?? undefined,
              matchConfidence: match?.score ?? undefined,
              status: 'pending',
            },
          });
        }),
      );

      await prisma.ingestionJob.update({
        where: { id: job.id },
        data: {
          status: JobStatus.NEEDS_REVIEW,
          result: { store: receipt.store, date: receipt.date, total: receipt.total, confidence, modelUsed },
        },
      });
      return { jobId: job.id, lineCount: receipt.lines.length, confidence, modelUsed };
    } catch (err) {
      await prisma.ingestionJob.update({
        where: { id: job.id },
        data: { status: JobStatus.FAILED, error: err instanceof Error ? err.message : String(err) },
      });
      reply.code(502);
      return { jobId: job.id, message: 'OCR failed', error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get('/jobs', async (req) => {
    const household = await getHousehold(req);
    return prisma.ingestionJob.findMany({
      where: { householdId: household.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });

  app.get('/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    return prisma.ingestionJob.findUniqueOrThrow({ where: { id }, include: { lines: true } });
  });

  app.get('/review/pending', async (req) => {
    const household = await getHousehold(req);
    return prisma.extractionLine.findMany({
      where: { status: 'pending', job: { householdId: household.id } },
      include: { job: true },
      orderBy: { id: 'asc' },
    });
  });

  // Confirm/correct a line: writes a price observation + inventory lot, and learns an alias.
  app.post('/review/lines/:id/resolve', async (req) => {
    const { id } = req.params as { id: string };
    const data = reviewResolveSchema.parse(req.body);
    const line = await prisma.extractionLine.findUniqueOrThrow({ where: { id }, include: { job: true } });

    if (data.action === 'reject') {
      return prisma.extractionLine.update({ where: { id }, data: { status: 'rejected' } });
    }

    const providerId = line.job.providerId;
    const productId = data.providerProductId ?? line.matchProductId ?? undefined;

    return prisma.$transaction(async (tx) => {
      let targetProductId = productId;

      // "new": create a ProviderProduct (optionally linked to a canonical item) from the line.
      if (data.action === 'new') {
        if (!providerId) throw new Error('Cannot create product: job has no providerId');
        const created = await tx.providerProduct.create({
          data: {
            providerId,
            canonicalItemId: data.canonicalItemId,
            rawName: line.rawName,
          },
        });
        targetProductId = created.id;
      }
      if (!targetProductId) throw new Error('No product to attribute this line to');

      // Price observation from the receipt line.
      if (line.totalPrice != null || line.unitPrice != null) {
        await tx.priceObservation.create({
          data: {
            providerProductId: targetProductId,
            price: Number(line.unitPrice ?? line.totalPrice).toFixed(2),
            source: PriceSource.OCR,
            observedAt: new Date(),
          },
        });
      }

      // Inventory lot, if this product maps to a canonical item.
      const product = await tx.providerProduct.findUniqueOrThrow({ where: { id: targetProductId } });
      if (product.canonicalItemId && product.baseQuantity) {
        await tx.inventoryLot.create({
          data: {
            householdId: line.job.householdId,
            canonicalItemId: product.canonicalItemId,
            quantity: (line.quantity ? Number(line.quantity) : 1).toString(),
            unit: product.packUnit ?? 'EACH',
            baseQuantity: Number(product.baseQuantity).toString(),
          },
        });
      }

      // Learn the alias so the next identical line auto-matches.
      if (providerId) {
        await tx.productAlias.upsert({
          where: { providerId_normalizedRawName: { providerId, normalizedRawName: normalizeName(line.rawName) } },
          create: { providerId, normalizedRawName: normalizeName(line.rawName), providerProductId: targetProductId },
          update: { providerProductId: targetProductId },
        });
      }

      return tx.extractionLine.update({
        where: { id },
        data: { status: 'confirmed', matchProductId: targetProductId },
      });
    });
  });
}
