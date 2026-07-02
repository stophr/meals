import { prisma, PriceSource } from '@meals/db';
import type { Provider } from '@meals/db';
import {
  clientToken,
  refreshUserToken,
  searchProducts,
  type KrogerConfig,
  type KrogerTokens,
} from '@meals/ingestion';
import { matchLine, normalizeName, toBaseQuantity, parseIngredientLine } from '@meals/core';
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

  for (const item of items) {
    result.itemsQueried++;
    let products;
    try {
      products = await searchProducts(cfg, token, {
        term: item.name,
        locationId,
        limit: 6,
        timeoutMs: 8000,
      });
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      result.unmatched.push(item.name);
      if (consecutiveFailures >= 3) {
        throw new Error(
          'Kroger Products API is not responding. If this app uses the Certification ' +
            'environment (api-ce), note that cert has NO live product catalog (504s) — register ' +
            'a Production app and set KROGER_API_BASE=https://api.kroger.com/v1. ' +
            `Last error: ${err instanceof Error ? err.message : err}`,
        );
      }
      continue;
    }
    if (!products.length) {
      result.unmatched.push(item.name);
      continue;
    }

    // Best catalog hit for this canonical item (fuzzy over description; cheapest tie-break).
    const match = matchLine(
      item.name,
      products.map((p) => ({ productId: p.upc, text: `${p.brand ?? ''} ${p.description}`.trim() })),
    );
    const chosen =
      products.find((p) => p.upc === match.productId && match.decision !== 'new') ??
      products.filter((p) => p.regular != null).sort((a, b) => (a.regular ?? 9e9) - (b.regular ?? 9e9))[0];
    if (!chosen || chosen.regular == null) {
      result.unmatched.push(item.name);
      continue;
    }

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
      update: { canonicalItemId: item.id, rawName: chosen.description, sizeText: chosen.size },
    });
    result.productsUpserted++;

    const effective = chosen.promo ?? chosen.regular;
    await prisma.priceObservation.create({
      data: {
        providerProductId: product.id,
        price: effective.toFixed(2),
        pricePerBaseUnit: base && base.baseQuantity > 0 ? (effective / base.baseQuantity).toFixed(6) : undefined,
        isDeal: chosen.promo != null,
        regularPrice: chosen.promo != null ? chosen.regular.toFixed(2) : undefined,
        validTo: new Date(Date.now() + 7 * 86_400_000), // refresh weekly; promos change with the ad cycle
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
  return result;
}
