import { prisma, PriceSource } from '@meals/db';
import type { Provider } from '@meals/db';
import {
  clientToken,
  refreshUserToken,
  searchProducts,
  type KrogerConfig,
  type KrogerTokens,
} from '@meals/ingestion';
import { similarity, normalizeName, toBaseQuantity, parseIngredientLine } from '@meals/core';
import { env } from '../env.js';

export function krogerConfig(): KrogerConfig | null {
  if (!env.KROGER_CLIENT_ID || !env.KROGER_CLIENT_SECRET) return null;
  return {
    clientId: env.KROGER_CLIENT_ID,
    clientSecret: env.KROGER_CLIENT_SECRET,
    redirectUri: env.KROGER_REDIRECT_URI,
    baseUrl: env.KROGER_API_BASE,
  };
}

export function krogerLocationId(provider: Provider): string | null {
  const integ = provider.integration as { type?: string; locationId?: string } | null;
  return integ?.type === 'kroger' && integ.locationId ? integ.locationId : null;
}

// App token cache (client credentials, ~30 min lifetime).
let appToken: KrogerTokens | null = null;
export async function getAppToken(cfg: KrogerConfig): Promise<string> {
  if (!appToken || appToken.expiresAt < new Date()) appToken = await clientToken(cfg);
  return appToken.accessToken;
}

/** User token for cart pushes; auto-refreshes via the stored refresh token. */
export async function getUserToken(cfg: KrogerConfig, householdId: string): Promise<string | null> {
  const row = await prisma.integrationToken.findUnique({
    where: { householdId_kind: { householdId, kind: 'kroger' } },
  });
  if (!row) return null;
  if (row.expiresAt && row.expiresAt > new Date()) return row.accessToken;
  if (!row.refreshToken) return null;
  const fresh = await refreshUserToken(cfg, row.refreshToken);
  await prisma.integrationToken.update({
    where: { id: row.id },
    data: {
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken ?? row.refreshToken,
      expiresAt: fresh.expiresAt,
    },
  });
  return fresh.accessToken;
}

export interface SyncResult {
  itemsQueried: number;
  productsUpserted: number;
  pricesRecorded: number;
  unmatched: string[];
}

/**
 * Sync real Fry's/Kroger prices for a set of canonical items at one provider:
 * search the store catalog per item, upsert ProviderProducts (UPC-keyed), record a
 * PriceObservation (promo-aware), and link products to canonical items.
 */
export async function syncPrices(
  cfg: KrogerConfig,
  provider: Provider,
  canonicalItemIds: string[],
): Promise<SyncResult> {
  const locationId = krogerLocationId(provider);
  if (!locationId) throw new Error('Provider is not linked to a Kroger location');

  const items = await prisma.canonicalItem.findMany({ where: { id: { in: canonicalItemIds } } });
  const token = await getAppToken(cfg);
  const result: SyncResult = { itemsQueried: 0, productsUpserted: 0, pricesRecorded: 0, unmatched: [] };

  // Kroger's gateway HANGS (rather than 403s) when the app isn't entitled to the Products
  // API — fail fast after consecutive network failures instead of timing out per item.
  let consecutiveFailures = 0;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (const item of items) {
    result.itemsQueried++;
    await sleep(350); // Kroger's edge gets flaky (slow 404s) on tight bursts — pace politely
    let products;
    try {
      products = await searchProducts(cfg, token, {
        term: item.name,
        locationId,
        limit: 6,
        timeoutMs: 12000,
      });
      consecutiveFailures = 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // HTTP 4xx = Kroger answered "no" for this term — count as unmatched, not a failure.
      if (/HTTP 4\d\d/.test(msg)) {
        result.unmatched.push(item.name);
        continue;
      }
      // Timeout / 5xx: retry once after a breather, then count toward the abort.
      await sleep(1500);
      try {
        products = await searchProducts(cfg, token, {
          term: item.name,
          locationId,
          limit: 6,
          timeoutMs: 12000,
        });
        consecutiveFailures = 0;
      } catch (err2) {
        consecutiveFailures++;
        result.unmatched.push(item.name);
        if (consecutiveFailures >= 5) {
          throw new Error(
            'Kroger Products API is not responding. If this app uses the Certification ' +
              'environment (api-ce), note that cert has NO live product catalog (504s) — register ' +
              'a Production app and set KROGER_API_BASE=https://api.kroger.com/v1. ' +
              `Last error: ${err2 instanceof Error ? err2.message : err2}`,
          );
        }
        continue;
      }
    }
    if (!products.length) {
      result.unmatched.push(item.name);
      continue;
    }

    // Keep ALL plausible size variants — bigger packs are often cheaper per unit, and the
    // optimizer/costing pick the right size per need. Variants gate on fuzzy similarity to
    // the item name; if none pass we fall back to the single best match (old behavior).
    const scored = products
      .filter((p) => p.regular != null)
      .map((p) => ({
        p,
        sim: similarity(item.name, `${p.brand ?? ''} ${p.description}`.trim()),
      }))
      .sort((a, b) => b.sim - a.sim);
    let variants = scored.filter((x) => x.sim >= 0.55).map((x) => x.p);
    if (!variants.length && scored.length) variants = [scored[0]!.p];
    if (!variants.length) {
      result.unmatched.push(item.name);
      continue;
    }
    variants = variants.slice(0, 5); // cap junk

    for (const chosen of variants) {
      const parsedSize = chosen.size ? parseIngredientLine(chosen.size) : null;
      const base =
        parsedSize?.quantity && parsedSize.unit
          ? toBaseQuantity(parsedSize.quantity, parsedSize.unit)
          : null;

      const product = await prisma.providerProduct.upsert({
        where: { providerId_upc: { providerId: provider.id, upc: chosen.upc } },
        create: {
          providerId: provider.id,
          canonicalItemId: item.id,
          rawName: chosen.description,
          brand: chosen.brand,
          sizeText: chosen.size,
          baseQuantity: base ? base.baseQuantity.toString() : undefined,
          upc: chosen.upc,
        },
        update: {
          canonicalItemId: item.id,
          rawName: chosen.description,
          sizeText: chosen.size,
          baseQuantity: base ? base.baseQuantity.toString() : undefined,
        },
      });
      result.productsUpserted++;

      const effective = chosen.promo ?? chosen.regular!;
      await prisma.priceObservation.create({
        data: {
          providerProductId: product.id,
          price: effective.toFixed(2),
          pricePerBaseUnit:
            base && base.baseQuantity > 0 ? (effective / base.baseQuantity).toFixed(6) : undefined,
          isDeal: chosen.promo != null,
          regularPrice: chosen.promo != null ? chosen.regular!.toFixed(2) : undefined,
          validTo: new Date(Date.now() + 7 * 86_400_000), // refresh weekly with the ad cycle
          source: PriceSource.SCRAPE,
          rawText: `${chosen.description} ${chosen.size ?? ''}`.trim(),
        },
      });
      result.pricesRecorded++;

      // Persist the alias so receipt OCR lines auto-match this product too.
      await prisma.productAlias.upsert({
        where: {
          providerId_normalizedRawName: {
            providerId: provider.id,
            normalizedRawName: normalizeName(chosen.description),
          },
        },
        create: {
          providerId: provider.id,
          normalizedRawName: normalizeName(chosen.description),
          providerProductId: product.id,
        },
        update: { providerProductId: product.id },
      });
    }
  }
  return result;
}
