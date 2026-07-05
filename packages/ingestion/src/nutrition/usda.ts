// USDA FoodData Central client (fdc.nal.usda.gov). Two lookups:
//   byUpc  — Branded foods carry a gtinUpc + per-serving labelNutrients (best for a scan).
//   byName — Foundation / SR Legacy generic foods, per-100g (best for recipe ingredients).
// Free API key required (DEMO_KEY works but is rate-limited).

export interface UsdaConfig {
  apiKey: string;
  baseUrl?: string; // default https://api.nal.usda.gov/fdc/v1
}

export interface UsdaNutrition {
  description?: string;
  brand?: string;
  servingSize?: number; // amount of ONE serving
  servingUnit?: string; // 'g' | 'ml' | 'oz' ...
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

function base(cfg: UsdaConfig): string {
  return (cfg.baseUrl ?? 'https://api.nal.usda.gov/fdc/v1').replace(/\/$/, '');
}

interface FdcFood {
  description?: string;
  brandName?: string;
  brandOwner?: string;
  gtinUpc?: string;
  servingSize?: number;
  servingSizeUnit?: string;
  householdServingFullText?: string;
  dataType?: string;
  labelNutrients?: Record<string, { value?: number }>;
  foodNutrients?: { nutrientId?: number; number?: string; value?: number; unitName?: string }[];
}

async function search(cfg: UsdaConfig, params: Record<string, string>): Promise<FdcFood[]> {
  const q = new URLSearchParams({ ...params, api_key: cfg.apiKey });
  const res = await fetch(`${base(cfg)}/foods/search?${q}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`USDA HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const data = (await res.json()) as { foods?: FdcFood[] };
  return data.foods ?? [];
}

// FDC nutrient ids (per-100g foodNutrients path).
const NUT = { calories: 1008, proteinG: 1003, carbsG: 1005, fatG: 1004, satFatG: 1258, fiberG: 1079, sugarG: 2000, sodiumMg: 1093 };

function fromFoodNutrients(food: FdcFood): Partial<UsdaNutrition> {
  const by = new Map((food.foodNutrients ?? []).map((n) => [n.nutrientId, n.value]));
  const g = (id: number) => (typeof by.get(id) === 'number' ? by.get(id) : undefined);
  return {
    calories: g(NUT.calories),
    proteinG: g(NUT.proteinG),
    carbsG: g(NUT.carbsG),
    fatG: g(NUT.fatG),
    satFatG: g(NUT.satFatG),
    fiberG: g(NUT.fiberG),
    sugarG: g(NUT.sugarG) ?? g(1063),
    sodiumMg: g(NUT.sodiumMg),
  };
}

function fromLabelNutrients(food: FdcFood): Partial<UsdaNutrition> {
  const l = food.labelNutrients ?? {};
  const v = (k: string) => (typeof l[k]?.value === 'number' ? l[k]!.value : undefined);
  return {
    calories: v('calories'),
    proteinG: v('protein'),
    carbsG: v('carbohydrates'),
    fatG: v('fat'),
    satFatG: v('saturatedFat'),
    fiberG: v('fiber'),
    sugarG: v('sugars'),
    sodiumMg: v('sodium'),
  };
}

const digits = (s: string) => s.replace(/\D/g, '').replace(/^0+/, '');

/** Branded food by barcode (per-serving nutrition from the Nutrition Facts label). */
export async function lookupUsdaByUpc(cfg: UsdaConfig, upc: string): Promise<UsdaNutrition | null> {
  let foods: FdcFood[];
  try {
    foods = await search(cfg, { query: upc, dataType: 'Branded', pageSize: '10' });
  } catch {
    return null;
  }
  const want = digits(upc);
  const food = foods.find((f) => f.gtinUpc && digits(f.gtinUpc) === want);
  if (!food) return null;
  const label = food.labelNutrients ? fromLabelNutrients(food) : {};
  const hasLabel = Object.values(label).some((x) => x != null);
  return {
    description: food.description,
    brand: food.brandName || food.brandOwner || undefined,
    servingSize: food.servingSize,
    servingUnit: food.servingSizeUnit,
    servingText: food.householdServingFullText,
    ...(hasLabel ? label : fromFoodNutrients(food)),
  };
}

// Bias the by-name pick toward the raw/whole form (what a recipe ingredient or loose produce
// means) and away from processed entries, which otherwise win alphabetically ("Bananas,
// dehydrated" at 346 kcal instead of "Bananas, raw" at 89).
const PROCESSED = [
  'dehydrated', 'dried', 'powder', 'juice', 'canned', 'cooked', 'boiled', 'fried', 'roasted',
  'chips', 'sauce', 'pie', 'baby food', 'fritter', 'flake', 'candied', 'sweetened', 'frozen',
];
function nameScore(desc: string): number {
  const d = desc.toLowerCase();
  let s = /\braw\b/.test(d) ? 3 : 0;
  for (const bad of PROCESSED) if (d.includes(bad)) s -= 3;
  return s - d.length * 0.005; // prefer simpler/shorter descriptions
}

/** Generic ingredient by name (per-100g). Serving basis is 100 g. */
export async function lookupUsdaByName(cfg: UsdaConfig, name: string): Promise<UsdaNutrition | null> {
  let foods: FdcFood[];
  try {
    foods = await search(cfg, { query: name, dataType: 'Foundation,SR Legacy', pageSize: '15' });
  } catch {
    return null;
  }
  const ranked = foods
    .map((f) => ({ f, macros: fromFoodNutrients(f) }))
    .filter((x) => Object.values(x.macros).some((v) => v != null))
    .sort((a, b) => nameScore(b.f.description ?? '') - nameScore(a.f.description ?? ''));
  const best = ranked[0];
  if (!best) return null;
  return { description: best.f.description, servingSize: 100, servingUnit: 'g', servingText: '100 g', ...best.macros };
}
