import { z } from 'zod';

// Unit + dimension enums MUST mirror the Prisma enums in packages/db/prisma/schema.prisma.
// This module owns the single source of truth for unit conversion; api validation, core
// logic, and the web UI all consume it.

export const UNIT_DIMENSIONS = ['MASS', 'VOLUME', 'COUNT'] as const;
export const unitDimensionSchema = z.enum(UNIT_DIMENSIONS);
export type UnitDimension = z.infer<typeof unitDimensionSchema>;

export const UNITS = [
  'MG',
  'G',
  'KG',
  'OZ',
  'LB',
  'ML',
  'L',
  'FLOZ',
  'CUP',
  'TBSP',
  'TSP',
  'EACH',
  'PACK',
  'BUNCH',
  'CAN',
  'BOTTLE',
] as const;
export const unitSchema = z.enum(UNITS);
export type Unit = z.infer<typeof unitSchema>;

interface UnitDef {
  dimension: UnitDimension;
  // Multiply a value in this unit by `factor` to get the dimension's base unit
  // (MASS->G, VOLUME->ML, COUNT->EACH).
  factor: number;
}

export const UNIT_TABLE: Record<Unit, UnitDef> = {
  // MASS (base: G)
  MG: { dimension: 'MASS', factor: 0.001 },
  G: { dimension: 'MASS', factor: 1 },
  KG: { dimension: 'MASS', factor: 1000 },
  OZ: { dimension: 'MASS', factor: 28.3495 },
  LB: { dimension: 'MASS', factor: 453.592 },
  // VOLUME (base: ML)
  ML: { dimension: 'VOLUME', factor: 1 },
  L: { dimension: 'VOLUME', factor: 1000 },
  FLOZ: { dimension: 'VOLUME', factor: 29.5735 },
  CUP: { dimension: 'VOLUME', factor: 236.588 },
  TBSP: { dimension: 'VOLUME', factor: 14.7868 },
  TSP: { dimension: 'VOLUME', factor: 4.92892 },
  // COUNT (base: EACH) — count units are 1 item each; PACK is treated as one countable unit.
  EACH: { dimension: 'COUNT', factor: 1 },
  PACK: { dimension: 'COUNT', factor: 1 },
  BUNCH: { dimension: 'COUNT', factor: 1 },
  CAN: { dimension: 'COUNT', factor: 1 },
  BOTTLE: { dimension: 'COUNT', factor: 1 },
};

export const BASE_UNIT: Record<UnitDimension, Unit> = {
  MASS: 'G',
  VOLUME: 'ML',
  COUNT: 'EACH',
};

export function dimensionOf(unit: Unit): UnitDimension {
  return UNIT_TABLE[unit].dimension;
}

export interface NormalizedQuantity {
  dimension: UnitDimension;
  baseUnit: Unit;
  baseQuantity: number;
}

/** Convert a (value, unit) pair to its dimension's base unit. */
export function toBaseQuantity(value: number, unit: Unit): NormalizedQuantity {
  const def = UNIT_TABLE[unit];
  return {
    dimension: def.dimension,
    baseUnit: BASE_UNIT[def.dimension],
    baseQuantity: value * def.factor,
  };
}

/**
 * Convert a value between two units of the SAME dimension. Cross-dimension conversion
 * (e.g. CUP of flour -> G, which needs density) is intentionally unsupported in the MVP
 * and throws so callers surface it instead of silently producing wrong numbers.
 */
export function convert(value: number, from: Unit, to: Unit): number {
  const a = UNIT_TABLE[from];
  const b = UNIT_TABLE[to];
  if (a.dimension !== b.dimension) {
    throw new Error(
      `Cannot convert ${from} (${a.dimension}) to ${to} (${b.dimension}): cross-dimension conversion needs density and is out of MVP scope.`,
    );
  }
  return (value * a.factor) / b.factor;
}

// ---- Density bridge: cross-dimension conversion for a single item ----
// Per-item factors let us reconcile a weight in the pantry against a volume in a recipe
// (a "5 lb sugar bag" vs "2 cups sugar"). Grams is the pivot. Missing a needed factor
// returns null so callers fall back to same-dimension math instead of guessing.

export interface DensityFactors {
  gramsPerMl?: number | null; // density (mass per volume)
  gramsPerEach?: number | null; // typical mass of one unit (1 egg ≈ 50 g)
}

export interface DimensionedAmount {
  base: number; // in the dimension's base unit: G / ML / EACH
  dim: UnitDimension;
}

/** A base quantity (G/ML/EACH) expressed in grams, or null if the factor is unknown. */
export function baseToGrams(base: number, dim: UnitDimension, f: DensityFactors): number | null {
  if (dim === 'MASS') return base;
  if (dim === 'VOLUME') return f.gramsPerMl ? base * f.gramsPerMl : null;
  return f.gramsPerEach ? base * f.gramsPerEach : null; // COUNT
}

/** Grams expressed back in a target dimension's base unit, or null if unknown. */
export function gramsToBase(grams: number, dim: UnitDimension, f: DensityFactors): number | null {
  if (dim === 'MASS') return grams;
  if (dim === 'VOLUME') return f.gramsPerMl ? grams / f.gramsPerMl : null;
  return f.gramsPerEach ? grams / f.gramsPerEach : null;
}

/**
 * Convert a base quantity from one dimension to another via the grams pivot. Identity when
 * the dimensions match (no factor needed). Returns null when the bridge is missing — so a
 * "16 oz" pack can be measured against a "cups" need only when a density is known.
 */
export function crossConvert(
  base: number,
  fromDim: UnitDimension,
  toDim: UnitDimension,
  f: DensityFactors,
): number | null {
  if (fromDim === toDim) return base;
  const g = baseToGrams(base, fromDim, f);
  return g == null ? null : gramsToBase(g, toDim, f);
}

/**
 * Net a need (in its own dimension) against pantry stock of any dimension, bridging via
 * density when possible. Returns the shortfall in the NEED's dimension. Falls back to
 * same-dimension netting when a conversion factor is missing.
 */
export function reconcile(
  needBase: number,
  needDim: UnitDimension,
  lots: DimensionedAmount[],
  f: DensityFactors,
): { shortfallBase: number; covered: boolean } {
  const needG = baseToGrams(needBase, needDim, f);
  if (needG != null) {
    // Sum every lot we CAN convert to grams. A lot we can't convert (a different dimension
    // with no factor) simply can't satisfy this need — skip it, don't discard the rest.
    let haveG = 0;
    for (const l of lots) {
      const g = baseToGrams(l.base, l.dim, f);
      if (g != null) haveG += g;
    }
    const shortG = Math.max(0, needG - haveG);
    return { shortfallBase: gramsToBase(shortG, needDim, f) ?? 0, covered: shortG <= 1e-6 };
  }
  // The need's own dimension has no factor: only same-dimension stock can cover it.
  const haveSame = lots.filter((l) => l.dim === needDim).reduce((s, l) => s + l.base, 0);
  const short = Math.max(0, needBase - haveSame);
  return { shortfallBase: short, covered: short <= 1e-6 };
}

// ---- Imperial display ----
// Internal storage stays SI (g/ml); the UI is US-household Imperial.

const FRAC = ['', '⅛', '¼', '⅜', '½', '⅝', '¾', '⅞'];
function niceFrac(x: number): string {
  const whole = Math.floor(x);
  const eighths = Math.round((x - whole) * 8);
  if (eighths === 8) return String(whole + 1);
  const f = FRAC[eighths];
  if (whole === 0) return f || '0';
  return f ? `${whole}${f}` : String(whole);
}
function dec(x: number): string {
  return (Math.round(x * 10) / 10).toString();
}

// Rewrite metric measurements embedded in free text ("500g minced beef") to Imperial
// ("1.1 lb minced beef"), leaving everything else untouched. Used to display recipe lines
// sourced with metric units to a US household.
const METRIC_TOKEN =
  /(\d+(?:[.,]\d+)?)\s?(kilograms?|kg|milligrams?|mg|grams?|g|millilitres?|milliliters?|ml|centilitres?|cl|litres?|liters?|l)\b/gi;

export function imperializeText(text: string): string {
  return text.replace(METRIC_TOKEN, (whole, numStr: string, unitRaw: string) => {
    const n = parseFloat(numStr.replace(',', '.'));
    if (!isFinite(n)) return whole;
    const u = unitRaw.toLowerCase();
    if (u.startsWith('kg') || u.startsWith('kilogram')) return formatImperial(n * 1000, 'MASS');
    if (u.startsWith('mg') || u.startsWith('milligram')) return formatImperial(n / 1000, 'MASS');
    if (u === 'g' || u.startsWith('gram')) return formatImperial(n, 'MASS');
    if (u === 'l' || u.startsWith('litre') || u.startsWith('liter')) return formatImperial(n * 1000, 'VOLUME');
    if (u.startsWith('cl') || u.startsWith('centilitre')) return formatImperial(n * 10, 'VOLUME');
    return formatImperial(n, 'VOLUME'); // ml / millilitre
  });
}

/** Render a base quantity (G/ML/EACH) as a friendly Imperial string ("1½ cup", "1.1 lb"). */
export function formatImperial(base: number, dim: UnitDimension): string {
  if (dim === 'COUNT') return niceFrac(base);
  if (dim === 'MASS') {
    const lb = base / 453.592;
    if (lb >= 1) return `${dec(lb)} lb`;
    return `${dec(base / 28.3495)} oz`;
  }
  const ml = base;
  if (ml / 3785.41 >= 1) return `${dec(ml / 3785.41)} gal`;
  if (ml / 946.353 >= 1) return `${dec(ml / 946.353)} qt`;
  if (ml / 236.588 >= 0.25) return `${niceFrac(ml / 236.588)} cup`;
  if (ml / 29.5735 >= 1) return `${dec(ml / 29.5735)} fl oz`;
  if (ml / 14.7868 >= 1) return `${niceFrac(ml / 14.7868)} tbsp`;
  return `${niceFrac(ml / 4.92892)} tsp`;
}
