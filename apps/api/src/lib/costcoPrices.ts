import { prisma, PriceSource } from '@meals/db';
import { matchLine, normalizeName } from '@meals/core';

// Record Costco prices (from the bookmarklet paste OR the digital-receipt script) under the
// Costco provider. Item numbers become SKUs; confident name matches auto-link to canonical
// items (Costco abbreviations are rough, so unlinked ones still record and link later).

export interface CostcoPriceInput {
  name: string;
  price: number;
  itemNumber?: string;
  size?: string;
  date?: Date;
}

export interface RecordResult {
  recorded: number;
  linked: number;
  skipped: number;
}

export async function recordCostcoPrices(
  householdId: string,
  inputs: CostcoPriceInput[],
): Promise<RecordResult> {
  const costco = await prisma.provider.findFirst({
    where: { householdId, name: { startsWith: 'Costco' } },
  });
  if (!costco) throw new Error('No Costco provider — create one first');

  const items = await prisma.canonicalItem.findMany({ where: { householdId } });
  const candidates = items.map((i) => ({ productId: i.id, text: i.name }));

  const result: RecordResult = { recorded: 0, linked: 0, skipped: 0 };

  // Keep the latest price per stable key within this batch.
  const byKey = new Map<string, CostcoPriceInput>();
  for (const raw of inputs) {
    const name = raw.name?.trim();
    const price = Number(raw.price);
    if (!name || !Number.isFinite(price) || price <= 0) {
      result.skipped++;
      continue;
    }
    const key = raw.itemNumber ? `i:${raw.itemNumber}` : `n:${normalizeName(name)}`;
    if (!key || key === 'n:') {
      result.skipped++;
      continue;
    }
    byKey.set(key, { ...raw, name, price });
  }

  for (const [key, line] of byKey) {
    const upc = line.itemNumber ? `costco:${line.itemNumber}` : `costco:${key}`;
    const match = candidates.length ? matchLine(line.name, candidates) : null;
    const canonicalItemId = match?.decision === 'auto' ? match.productId : null;
    if (canonicalItemId) result.linked++;

    const product = await prisma.providerProduct.upsert({
      where: { providerId_upc: { providerId: costco.id, upc } },
      create: {
        providerId: costco.id,
        canonicalItemId,
        rawName: line.name,
        sizeText: line.size,
        sku: line.itemNumber,
        upc,
      },
      update: {
        rawName: line.name,
        sizeText: line.size,
        ...(canonicalItemId ? { canonicalItemId } : {}),
      },
    });

    const when = line.date ?? new Date();
    await prisma.priceObservation.create({
      data: {
        providerProductId: product.id,
        price: line.price.toFixed(2),
        source: PriceSource.SCRAPE,
        observedAt: when,
        validTo: new Date(when.getTime() + 60 * 86_400_000), // warehouse prices move slowly
        rawText: `${line.name}${line.itemNumber ? ` #${line.itemNumber}` : ''}`,
      },
    });
    await prisma.productAlias.upsert({
      where: {
        providerId_normalizedRawName: {
          providerId: costco.id,
          normalizedRawName: normalizeName(line.name),
        },
      },
      create: {
        providerId: costco.id,
        normalizedRawName: normalizeName(line.name),
        providerProductId: product.id,
      },
      update: { providerProductId: product.id },
    });
    result.recorded++;
  }
  return result;
}
