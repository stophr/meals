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
