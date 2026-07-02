import { prisma, PriceSource } from '@meals/db';
import { matchLine, normalizeName, parseIngredientLine, toBaseQuantity } from '@meals/core';

// Record store prices under a provider (used by: Costco digital receipts, the Costco
// bookmarklet paste, and the free-form LLM paste). Item numbers become SKUs; a size string
// ("4 lb") is parsed to a base quantity for proportional costing; confident name matches
// auto-link to canonical items (rough abbreviations stay unlinked and record anyway).

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

/** Generic per-provider recorder. `upcPrefix` namespaces the synthetic UPC so re-runs dedup. */
export async function recordProviderPrices(
  householdId: string,
  providerId: string,
  inputs: CostcoPriceInput[],
  opts: { source: PriceSource; upcPrefix: string },
): Promise<RecordResult> {
  const provider = await prisma.provider.findFirst({ where: { id: providerId, householdId } });
  if (!provider) throw new Error('Provider not found');

  const items = await prisma.canonicalItem.findMany({ where: { householdId } });
  const candidates = items.map((i) => ({ productId: i.id, text: i.name }));
  const result: RecordResult = { recorded: 0, linked: 0, skipped: 0 };

  // Keep the latest input per stable key within this batch.
  const byKey = new Map<string, CostcoPriceInput>();
  for (const raw of inputs) {
    const name = raw.name?.trim();
    const price = Number(raw.price);
    if (!name || !Number.isFinite(price) || price <= 0) {
      result.skipped++;
      continue;
    }
    const key = raw.itemNumber ? raw.itemNumber : `n:${normalizeName(name)}`;
    if (key === 'n:') {
      result.skipped++;
      continue;
    }
    byKey.set(key, { ...raw, name, price });
  }

  for (const [key, line] of byKey) {
    const upc = `${opts.upcPrefix}:${key}`;
    const match = candidates.length ? matchLine(line.name, candidates) : null;
    const canonicalItemId = match?.decision === 'auto' ? match.productId : null;
    if (canonicalItemId) result.linked++;

    const parsed = line.size ? parseIngredientLine(line.size) : null;
    const base =
      parsed?.quantity && parsed.unit ? toBaseQuantity(parsed.quantity, parsed.unit) : null;

    const product = await prisma.providerProduct.upsert({
      where: { providerId_upc: { providerId, upc } },
      create: {
        providerId,
        canonicalItemId,
        rawName: line.name,
        sizeText: line.size,
        sku: line.itemNumber,
        baseQuantity: base ? base.baseQuantity.toString() : undefined,
        upc,
      },
      update: {
        rawName: line.name,
        sizeText: line.size,
        baseQuantity: base ? base.baseQuantity.toString() : undefined,
        ...(canonicalItemId ? { canonicalItemId } : {}),
      },
    });

    const when = line.date ?? new Date();
    await prisma.priceObservation.create({
      data: {
        providerProductId: product.id,
        price: line.price.toFixed(2),
        pricePerBaseUnit:
          base && base.baseQuantity > 0 ? (line.price / base.baseQuantity).toFixed(6) : undefined,
        source: opts.source,
        observedAt: when,
        validTo: new Date(when.getTime() + 60 * 86_400_000),
        rawText: `${line.name}${line.itemNumber ? ` #${line.itemNumber}` : ''}`,
      },
    });
    await prisma.productAlias.upsert({
      where: {
        providerId_normalizedRawName: { providerId, normalizedRawName: normalizeName(line.name) },
      },
      create: {
        providerId,
        normalizedRawName: normalizeName(line.name),
        providerProductId: product.id,
      },
      update: { providerProductId: product.id },
    });
    result.recorded++;
  }
  return result;
}

/** Costco convenience: resolves the Costco provider and records with its UPC namespace. */
export async function recordCostcoPrices(
  householdId: string,
  inputs: CostcoPriceInput[],
): Promise<RecordResult> {
  const costco = await prisma.provider.findFirst({
    where: { householdId, name: { startsWith: 'Costco' } },
  });
  if (!costco) throw new Error('No Costco provider — create one first');
  return recordProviderPrices(householdId, costco.id, inputs, {
    source: PriceSource.SCRAPE,
    upcPrefix: 'costco',
  });
}
