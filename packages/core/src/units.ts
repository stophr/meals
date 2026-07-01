// Re-export the shared unit machinery so domain code can import everything unit-related
// from @meals/core. The single source of truth lives in @meals/shared/units.
export {
  toBaseQuantity,
  convert,
  dimensionOf,
  UNIT_TABLE,
  BASE_UNIT,
  UNITS,
  UNIT_DIMENSIONS,
} from '@meals/shared';
export type { Unit, UnitDimension, NormalizedQuantity } from '@meals/shared';
