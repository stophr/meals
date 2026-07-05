// Open Food Facts product lookup — description/brand/size AND nutrition (per serving when the
// entry has it, else per 100 g/ml). Free, no key. Returns null on miss / error / timeout.

export interface OffNutrition {
  servingSize?: number; // one serving amount
  servingUnit?: string; // 'g' | 'ml'
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

export interface OffProductData {
  name: string;
  brand: string | null;
  quantity: string | null; // pack size text, e.g. "500 ml"
  nutrition: OffNutrition | null;
}

interface OffProduct {
  product_name?: string;
  product_name_en?: string;
  brands?: string;
  quantity?: string;
  serving_size?: string;
  serving_quantity?: number | string;
  nutrition_data_per?: string; // "serving" | "100g"
  nutriments?: Record<string, number | string | undefined>;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return isFinite(n) ? n : undefined;
};

function extractNutrition(p: OffProduct): OffNutrition | null {
  const n = p.nutriments;
  if (!n) return null;
  // Prefer per-serving figures; fall back to per-100g (serving basis then = 100 g/ml).
  const per = (key: string) => num(n[`${key}_serving`]) ?? num(n[`${key}_100g`]);
  const hasServing = num(n['energy-kcal_serving']) != null || num(n['proteins_serving']) != null;
  const sodiumG = per('sodium');
  const saltG = per('salt');
  const sodiumMg = sodiumG != null ? sodiumG * 1000 : saltG != null ? (saltG / 2.5) * 1000 : undefined;

  const out: OffNutrition = {
    calories: num(n['energy-kcal_serving']) ?? num(n['energy-kcal_100g']),
    proteinG: per('proteins'),
    carbsG: per('carbohydrates'),
    sugarG: per('sugars'),
    fiberG: per('fiber'),
    fatG: per('fat'),
    satFatG: per('saturated-fat'),
    sodiumMg,
  };
  if (!Object.values(out).some((x) => x != null)) return null;

  if (hasServing) {
    const sq = num(p.serving_quantity);
    const unit = /ml|l\b/i.test(p.serving_size ?? '') ? 'ml' : 'g';
    out.servingSize = sq;
    out.servingUnit = sq != null ? unit : undefined;
    out.servingText = p.serving_size?.trim() || undefined;
  } else {
    out.servingSize = 100;
    out.servingUnit = /ml|l\b/i.test(p.quantity ?? '') ? 'ml' : 'g';
    out.servingText = `100 ${out.servingUnit}`;
  }
  return out;
}

export async function lookupOpenFoodFacts(code: string): Promise<OffProductData | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const fields =
      'product_name,product_name_en,brands,quantity,serving_size,serving_quantity,nutrition_data_per,nutriments';
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}?fields=${fields}`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Pantrezy/1.0 (grocery planner; self-hosted)' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { product?: OffProduct };
    const p = body.product;
    const name = (p?.product_name || p?.product_name_en || '').trim();
    if (!name) return null;
    return {
      name,
      brand: (p?.brands || '').split(',')[0]?.trim() || null,
      quantity: p?.quantity?.trim() || null,
      nutrition: p ? extractNutrition(p) : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
