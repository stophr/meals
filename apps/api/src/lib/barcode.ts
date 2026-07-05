import { prisma } from '@meals/db';
import { resolveCanonicalItem } from './resolveItem.js';

// UPC/EAN barcode resolution for phone-scanned pantry entry. A barcode identifies a product
// GLOBALLY (it's the same box of cereal in every store), so the UPC↔canonical-item mapping is
// cached on the (global) CanonicalItem.upcs array: the first scan does an Open Food Facts
// lookup; every later scan of the same product resolves from our own DB.

export interface BarcodeResolution {
  found: boolean;
  code: string;
  source?: 'known' | 'provider' | 'openfoodfacts';
  item?: { id: string; name: string; category: string | null; baseUnit: string | null };
  brand?: string | null;
  productName?: string | null;
}

/** Strip separators and validate as an 8/12/13/14-digit retail barcode. Returns null if bogus. */
export function normalizeUpc(raw: string): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  return /^\d{8}$|^\d{12,14}$/.test(digits) ? digits : null;
}

interface OffProduct {
  product_name?: string;
  product_name_en?: string;
  brands?: string;
  quantity?: string;
  categories?: string;
}

/** Look a barcode up in the free Open Food Facts database. Returns null on miss / error / timeout. */
export async function lookupOpenFoodFacts(
  code: string,
): Promise<{ name: string; brand: string | null; quantity: string | null } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const url = `https://world.openfoodfacts.org/api/v2/product/${code}?fields=product_name,product_name_en,brands,quantity,categories`;
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Pantrezy/1.0 (grocery planner; self-hosted)' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { status?: number; product?: OffProduct };
    const p = body.product;
    const name = (p?.product_name || p?.product_name_en || '').trim();
    if (!name) return null;
    const brand = (p?.brands || '').split(',')[0]?.trim() || null;
    return { name, brand, quantity: p?.quantity?.trim() || null };
  } catch {
    return null; // network error / abort / bad JSON -> treat as miss
  } finally {
    clearTimeout(timer);
  }
}

/** Record a barcode on a canonical item (idempotent — never duplicates in the array). */
async function cacheUpc(itemId: string, code: string): Promise<void> {
  const item = await prisma.canonicalItem.findUnique({
    where: { id: itemId },
    select: { upcs: true },
  });
  if (item && !item.upcs.includes(code)) {
    await prisma.canonicalItem.update({
      where: { id: itemId },
      data: { upcs: { push: code } },
    });
  }
}

/**
 * Resolve a scanned barcode to a canonical item:
 *   1. our own cache (CanonicalItem.upcs) — instant, offline-friendly;
 *   2. a matched store listing (ProviderProduct.upc), caching the mapping forward;
 *   3. Open Food Facts, resolving the returned name to a canonical item and caching the UPC.
 * Returns { found:false } when nothing recognizes it (caller falls back to manual entry).
 */
export async function resolveBarcode(code: string): Promise<BarcodeResolution> {
  const sel = { id: true, name: true, category: true, baseUnit: true } as const;

  // 1. Known barcode.
  const known = await prisma.canonicalItem.findFirst({ where: { upcs: { has: code } }, select: sel });
  if (known) return { found: true, code, source: 'known', item: known };

  // 2. A store listing already carries this UPC and is matched to an item.
  const product = await prisma.providerProduct.findFirst({
    where: { upc: code, canonicalItemId: { not: null } },
    select: { brand: true, canonicalItem: { select: sel } },
  });
  if (product?.canonicalItem) {
    await cacheUpc(product.canonicalItem.id, code);
    return { found: true, code, source: 'provider', item: product.canonicalItem, brand: product.brand };
  }

  // 3. Open Food Facts, then resolve + cache.
  const off = await lookupOpenFoodFacts(code);
  if (off) {
    const resolved = await resolveCanonicalItem(off.name);
    await cacheUpc(resolved.id, code);
    const item = await prisma.canonicalItem.findUniqueOrThrow({ where: { id: resolved.id }, select: sel });
    return { found: true, code, source: 'openfoodfacts', item, brand: off.brand, productName: off.name };
  }

  return { found: false, code };
}
