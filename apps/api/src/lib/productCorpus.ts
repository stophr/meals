// Local UPC corpus resolver. Given a barcode, return a Product (a "container" of an ingredient),
// building/refreshing it from the most accurate source first. The description group and the
// nutrition group are sourced by INDEPENDENT precedence:
//   description/brand/size:  Fry's/Kroger  >  other stores  >  Open Food Facts
//   nutrition (per serving): USDA FoodData Central  >  Open Food Facts
// A field-group is only overwritten by an equal-or-higher-priority source, so Fry's is never
// downgraded by OFF and a re-scan of an already-enriched product does no network I/O.

import { prisma } from '@meals/db';
import { toBaseQuantity, dimensionOf } from '@meals/core';
import { getProductByUpc, lookupUsdaByUpc, lookupUsdaByName, type KrogerProduct } from '@meals/ingestion';
import { krogerConfig, getAppToken, krogerLocationId } from './kroger.js';
import { resolveCanonicalItem } from './resolveItem.js';
import { lookupOpenFoodFacts } from './offProduct.js';
import { cleanOffName, parseQuantityText, unitWord, BASE_UNIT_FOR } from './upcUtil.js';
import { env } from '../env.js';

const DESC_RANK: Record<string, number> = { MANUAL: 4, KROGER: 3, STORE: 2, OFF: 1 };
const NUTR_RANK: Record<string, number> = { MANUAL: 4, USDA: 3, OFF: 1 };

interface Nutr {
  servingSize?: number;
  servingUnit?: string;
  servingText?: string;
  calories?: number;
  proteinG?: number;
  carbsG?: number;
  sugarG?: number;
  fiberG?: number;
  fatG?: number;
  satFatG?: number;
  sodiumMg?: number;
}

export interface ResolvedProduct {
  found: boolean;
  code: string;
  productId?: string;
  item?: { id: string; name: string; category: string | null; baseUnit: string | null };
  brand?: string | null;
  description?: string | null;
  size?: { quantity: number; unit: string } | null;
  nutrition?: Nutr | null;
  descriptionSource?: string;
  nutritionSource?: string | null;
}

const dec = (v?: number | null) => (v == null ? null : v.toFixed(2));
const hasMacros = (n: Nutr) => [n.calories, n.proteinG, n.carbsG, n.fatG].some((x) => x != null);

async function tryKroger(upc: string, householdId: string): Promise<KrogerProduct | null> {
  const cfg = krogerConfig();
  if (!cfg) return null;
  let token: string;
  try {
    token = await getAppToken(cfg);
  } catch {
    return null;
  }
  const providers = await prisma.provider.findMany({ where: { householdId } });
  const locationId = providers.map((p) => krogerLocationId(p)).find((x): x is string => !!x);
  return getProductByUpc(cfg, token, upc, locationId).catch(() => null);
}

async function fetchUsda(upc: string, name: string): Promise<Nutr | null> {
  const cfg = { apiKey: env.USDA_FDC_API_KEY, baseUrl: env.USDA_FDC_API_BASE };
  let u = await lookupUsdaByUpc(cfg, upc).catch(() => null);
  if (!u && name) u = await lookupUsdaByName(cfg, name).catch(() => null);
  return u && hasMacros(u) ? u : null;
}

function sizeFields(sizeText: string | null | undefined) {
  const size = parseQuantityText(sizeText);
  if (!size) return { packSize: null, packUnit: null, baseQuantity: null, size: null as null | { quantity: number; unit: string } };
  const base = toBaseQuantity(size.quantity, size.unit as never);
  return {
    packSize: String(size.quantity),
    packUnit: size.unit,
    baseQuantity: base.baseQuantity.toString(),
    size,
  };
}

function nutritionFields(n: Nutr) {
  const unit = n.servingUnit ? unitWord(n.servingUnit) : null;
  const servingBase =
    n.servingSize != null && unit ? toBaseQuantity(n.servingSize, unit as never).baseQuantity.toString() : null;
  return {
    servingText: n.servingText ?? (n.servingSize != null && n.servingUnit ? `${n.servingSize} ${n.servingUnit}` : null),
    servingBaseQuantity: servingBase,
    calories: dec(n.calories),
    proteinG: dec(n.proteinG),
    carbsG: dec(n.carbsG),
    sugarG: dec(n.sugarG),
    fiberG: dec(n.fiberG),
    fatG: dec(n.fatG),
    satFatG: dec(n.satFatG),
    sodiumMg: dec(n.sodiumMg),
  };
}

function nutritionOut(p: {
  servingSize?: unknown;
  servingText: string | null;
  calories: unknown;
  proteinG: unknown;
  carbsG: unknown;
  sugarG: unknown;
  fiberG: unknown;
  fatG: unknown;
  satFatG: unknown;
  sodiumMg: unknown;
  nutritionSource: string | null;
}): Nutr | null {
  if (!p.nutritionSource) return null;
  const n = (v: unknown) => (v == null ? undefined : Number(v));
  return {
    servingText: p.servingText ?? undefined,
    calories: n(p.calories),
    proteinG: n(p.proteinG),
    carbsG: n(p.carbsG),
    sugarG: n(p.sugarG),
    fiberG: n(p.fiberG),
    fatG: n(p.fatG),
    satFatG: n(p.satFatG),
    sodiumMg: n(p.sodiumMg),
  };
}

type ProductRow = Awaited<ReturnType<typeof prisma.product.findUnique>>;

async function shape(p: NonNullable<ProductRow>): Promise<ResolvedProduct> {
  const item = await prisma.canonicalItem.findUnique({
    where: { id: p.canonicalItemId },
    select: { id: true, name: true, category: true, baseUnit: true },
  });
  return {
    found: true,
    code: p.upc,
    productId: p.id,
    item: item ?? undefined,
    brand: p.brand,
    description: p.description,
    size: p.packSize != null && p.packUnit ? { quantity: Number(p.packSize), unit: p.packUnit } : null,
    nutrition: nutritionOut(p),
    descriptionSource: p.descriptionSource,
    nutritionSource: p.nutritionSource,
  };
}

/** Point the ingredient at this product for recipe-nutrition fallback, and seed its base unit. */
async function backfillItem(itemId: string, product: NonNullable<ProductRow>) {
  const item = await prisma.canonicalItem.findUnique({
    where: { id: itemId },
    select: { referenceProductId: true, baseUnit: true },
  });
  const data: Record<string, unknown> = {};
  if (!item?.referenceProductId) data.referenceProductId = product.id;
  if (!item?.baseUnit && product.packUnit) {
    const dim = dimensionOf(product.packUnit as never);
    data.baseUnit = BASE_UNIT_FOR[dim];
    data.baseDimension = dim;
  }
  if (Object.keys(data).length) await prisma.canonicalItem.update({ where: { id: itemId }, data });
}

export async function resolveProduct(upc: string, householdId: string): Promise<ResolvedProduct> {
  const existing = await prisma.product.findUnique({ where: { upc } });

  // Fast path: already enriched with nutrition — serve from the corpus, no network.
  if (existing && existing.nutritionSource) return shape(existing);

  // Gather sources. Kroger (preferred description) + OFF (description + nutrition) in parallel.
  const [kro, off] = await Promise.all([
    tryKroger(upc, householdId),
    lookupOpenFoodFacts(upc).catch(() => null),
  ]);
  if (!existing && !kro && !off) return { found: false, code: upc };

  const nameForUsda = kro?.description ?? existing?.description ?? off?.name ?? '';
  const usda = await fetchUsda(upc, nameForUsda);

  // ---- description candidate (Kroger > OFF) ----
  const descCand = kro
    ? { source: 'KROGER', description: cleanOffName(kro.description), brand: kro.brand ?? null, sizeText: kro.size ?? null }
    : off
      ? { source: 'OFF', description: cleanOffName(off.name), brand: off.brand, sizeText: off.quantity }
      : null;

  // ---- nutrition candidate (USDA > OFF) ----
  const nutrCand: { n: Nutr; source: string } | null = usda
    ? { n: usda, source: 'USDA' }
    : off?.nutrition
      ? { n: off.nutrition, source: 'OFF' }
      : null;

  const write: Record<string, unknown> = {};
  let description = existing?.description ?? cleanOffName(off?.name ?? kro?.description ?? upc);

  if (descCand && (!existing || DESC_RANK[descCand.source]! >= DESC_RANK[existing.descriptionSource]!)) {
    const sf = sizeFields(descCand.sizeText);
    description = descCand.description;
    Object.assign(write, {
      description: descCand.description,
      brand: descCand.brand,
      sizeText: descCand.sizeText,
      packSize: sf.packSize,
      packUnit: sf.packUnit,
      baseQuantity: sf.baseQuantity,
      descriptionSource: descCand.source,
      descriptionUpdatedAt: new Date(),
    });
  }

  if (nutrCand && (!existing?.nutritionSource || NUTR_RANK[nutrCand.source]! >= NUTR_RANK[existing.nutritionSource]!)) {
    Object.assign(write, nutritionFields(nutrCand.n), {
      nutritionSource: nutrCand.source,
      nutritionUpdatedAt: new Date(),
    });
  }

  const resolvedItem = await resolveCanonicalItem(description);

  // servings per container, if we now know both net contents and one serving.
  const baseQ = (write.baseQuantity as string) ?? existing?.baseQuantity?.toString() ?? null;
  const servBase = (write.servingBaseQuantity as string) ?? existing?.servingBaseQuantity?.toString() ?? null;
  if (baseQ && servBase && Number(servBase) > 0) write.servingsPerContainer = (Number(baseQ) / Number(servBase)).toFixed(2);

  const product = existing
    ? await prisma.product.update({ where: { id: existing.id }, data: { ...write, canonicalItemId: resolvedItem.id } })
    : await prisma.product.create({
        data: {
          upc,
          canonicalItemId: resolvedItem.id,
          description,
          descriptionSource: (write.descriptionSource as never) ?? ('MANUAL' as never),
          ...write,
        } as never,
      });

  await backfillItem(resolvedItem.id, product);
  return shape(product);
}
