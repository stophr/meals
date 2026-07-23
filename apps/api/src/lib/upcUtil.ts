// Small pure helpers for UPC/product handling, shared by the barcode route and the corpus
// resolver (kept separate so those two don't import each other).

// Barcode identity (normalize + corpus key) lives in @meals/shared — one module owns the rule
// for the API, the ingestion Kroger client, and the crawl/dedup scripts alike.
export { normalizeUpc, krogerProductKey, upcLookupForms } from '@meals/shared';

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

const MEASURE_UNIT = String.raw`fl\.?\s?oz|floz|oz|ml|cl|l|liters?|litres?|kg|mg|g|lbs?|gal(?:lons?)?|qt|pt`;
const MEASURE_MAP: Record<string, [string, number]> = {
  floz: ['FLOZ', 1], oz: ['OZ', 1],
  ml: ['ML', 1], cl: ['ML', 10],
  l: ['L', 1], liter: ['L', 1], liters: ['L', 1], litre: ['L', 1], litres: ['L', 1],
  g: ['G', 1], kg: ['KG', 1], mg: ['MG', 1],
  lb: ['LB', 1], lbs: ['LB', 1],
  gal: ['L', 3.78541], gallon: ['L', 3.78541], gallons: ['L', 3.78541],
  qt: ['L', 0.946353], pt: ['ML', 473.176],
};
// Words that mark a multipack "N <container> / M <measure>" (total = N × M).
const CONTAINER = String.raw`pk|packs?|ct|count|cans?|bottles?|btls?|pouch(?:es)?|bags?|boxes?|cups?|pods?|sticks?|bars?|rolls?|pieces?|pcs?|jars?|tubs?|cartons?|ea`;
// Count units (dimensionless): "12 ct", "2 pk", "1 ea", "6 pods", "1 dozen".
const COUNT_UNIT = String.raw`ct|count|pk|packs?|pc|pcs|pieces?|ea|each|cups?|pods?|cans?|bottles?|bars?|sticks?|rolls?|dozen`;

function toMeasure(valStr: string, unitStr: string): { quantity: number; unit: string } | null {
  const value = parseFloat(valStr.replace(',', '.'));
  if (!isFinite(value) || value <= 0) return null;
  const u = unitStr.replace(/[\s.]/g, '');
  const hit = MEASURE_MAP[u] ?? MEASURE_MAP[u.replace(/s$/, '')];
  if (!hit) return null;
  return { quantity: Math.round(value * hit[1] * 100) / 100, unit: hit[0] };
}

/**
 * Parse Fry's/Kroger (and OFF) size strings into our units. Handles single measures
 * ("32 fl oz", "1.5 L"), MULTIPACKS ("6 cans / 12 fl oz" → 72 fl oz; "3 x 5 oz" → 15 oz),
 * FRACTIONS ("1/2 gal" → 0.5 gal), and COUNT packs ("12 ct", "2 pk", "1 dozen" → EACH). Returns
 * null for dimensions/other non-contents strings ("0.94 in x 30 yd").
 */
export function parseQuantityText(q: string | null | undefined): { quantity: number; unit: string } | null {
  if (!q) return null;
  const s = q.toLowerCase().trim();

  // 1) Multipack "N <container> / M <measure>"  → total N×M.
  let m = s.match(new RegExp(String.raw`(\d+)\s*(?:${CONTAINER})\s*/\s*(\d+(?:[.,]\d+)?)\s*(${MEASURE_UNIT})\b`));
  if (m) {
    const per = toMeasure(m[2]!, m[3]!);
    const n = parseInt(m[1]!, 10);
    if (per && n > 0) return { quantity: Math.round(per.quantity * n * 100) / 100, unit: per.unit };
  }
  // 2) "N x M <measure>"  → total N×M.
  m = s.match(new RegExp(String.raw`(\d+)\s*x\s*(\d+(?:[.,]\d+)?)\s*(${MEASURE_UNIT})\b`));
  if (m) {
    const per = toMeasure(m[2]!, m[3]!);
    const n = parseInt(m[1]!, 10);
    if (per && n > 0) return { quantity: Math.round(per.quantity * n * 100) / 100, unit: per.unit };
  }
  // 3) Fraction "A/B <measure>" (e.g. "1/2 gal") — bare numbers, no container word.
  m = s.match(new RegExp(String.raw`^(\d+)\s*/\s*(\d+)\s*(${MEASURE_UNIT})\b`));
  if (m) {
    const per = toMeasure('1', m[3]!);
    const b = parseInt(m[2]!, 10);
    const frac = b ? parseInt(m[1]!, 10) / b : 0;
    if (per && frac > 0) return { quantity: Math.round(per.quantity * frac * 100) / 100, unit: per.unit };
  }
  // 4) Single measure — first occurrence (also covers dual-label "12oz / 340g" → 12 oz).
  m = s.match(new RegExp(String.raw`(\d+(?:[.,]\d+)?)\s*(${MEASURE_UNIT})\b`));
  if (m) {
    const r = toMeasure(m[1]!, m[2]!);
    if (r) return r;
  }
  // 5) Count pack → EACH (dimensionless).
  m = s.match(new RegExp(String.raw`(\d+)\s*(${COUNT_UNIT})\b`));
  if (m) {
    let n = parseInt(m[1]!, 10);
    if (/dozen/.test(m[2]!)) n *= 12;
    if (n > 0) return { quantity: n, unit: 'EACH' };
  }
  return null; // dimensions ("in"/"yd"/"ft") and anything else with no contents info
}
