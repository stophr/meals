// Small pure helpers for UPC/product handling, shared by the barcode route and the corpus
// resolver (kept separate so those two don't import each other).

/** Strip separators and validate as an 8/12/13/14-digit retail barcode. Returns null if bogus. */
export function normalizeUpc(raw: string): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  return /^\d{8}$|^\d{12,14}$/.test(digits) ? digits : null;
}

// Open Food Facts names are crowd-sourced and carry edition/packaging abbreviations that aren't
// part of the product ("Vinegar apple cider imp"). Drop the worst offenders from the name we
// canonicalize (brand + size are captured separately).
const OFF_NAME_NOISE = new Set(['imp', 'impt', 'imprt', 'imported']);
export function cleanOffName(name: string): string {
  const kept = name.split(/\s+/).filter((w) => w && !OFF_NAME_NOISE.has(w.toLowerCase()));
  return kept.join(' ').trim() || name.trim();
}

export const BASE_UNIT_FOR = { MASS: 'G', VOLUME: 'ML', COUNT: 'EACH' } as const;

/** Map a bare unit word ("g", "fl oz", "ml") to our Unit enum name, or null. */
export function unitWord(w: string): string | null {
  const u = w.toLowerCase().replace(/[\s.]/g, '');
  const MAP: Record<string, string> = {
    g: 'G', gram: 'G', grams: 'G', kg: 'KG', mg: 'MG',
    ml: 'ML', l: 'L', liter: 'L', litre: 'L', cl: 'ML',
    oz: 'OZ', floz: 'FLOZ', lb: 'LB', lbs: 'LB',
    tbsp: 'TBSP', tsp: 'TSP', cup: 'CUP',
  };
  return MAP[u] ?? MAP[u.replace(/s$/, '')] ?? null;
}

/** Parse a quantity string ("32 fl oz", "500 ml", "33 cl", "1.5 L") into our units. */
export function parseQuantityText(q: string | null | undefined): { quantity: number; unit: string } | null {
  if (!q) return null;
  const m = q
    .toLowerCase()
    .match(/(\d+(?:[.,]\d+)?)\s*(fl\.?\s?oz|floz|oz|ml|cl|l|liters?|litres?|kg|mg|g|lbs?|gal(?:lons?)?|qt|pt)\b/);
  if (!m) return null;
  const value = parseFloat(m[1]!.replace(',', '.'));
  if (!isFinite(value) || value <= 0) return null;
  const u = m[2]!.replace(/[\s.]/g, '');
  const MAP: Record<string, [string, number]> = {
    floz: ['FLOZ', 1], oz: ['OZ', 1],
    ml: ['ML', 1], cl: ['ML', 10],
    l: ['L', 1], liter: ['L', 1], liters: ['L', 1], litre: ['L', 1], litres: ['L', 1],
    g: ['G', 1], kg: ['KG', 1], mg: ['MG', 1],
    lb: ['LB', 1], lbs: ['LB', 1],
    gal: ['L', 3.78541], gallon: ['L', 3.78541], gallons: ['L', 3.78541],
    qt: ['L', 0.946353], pt: ['ML', 473.176],
  };
  const hit = MAP[u] ?? MAP[u.replace(/s$/, '')];
  if (!hit) return null;
  return { quantity: Math.round(value * hit[1] * 100) / 100, unit: hit[0] };
}
