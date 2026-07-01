import { describe, it, expect } from 'vitest';
import { toBaseQuantity, convert, dimensionOf } from './units.js';

describe('unit normalization', () => {
  it('converts mass units to grams', () => {
    expect(toBaseQuantity(1, 'KG').baseQuantity).toBe(1000);
    expect(toBaseQuantity(1, 'LB').baseQuantity).toBeCloseTo(453.592, 3);
    expect(toBaseQuantity(2, 'KG').baseUnit).toBe('G');
  });

  it('converts volume units to millilitres', () => {
    expect(toBaseQuantity(1, 'L').baseQuantity).toBe(1000);
    expect(toBaseQuantity(1, 'CUP').baseQuantity).toBeCloseTo(236.588, 3);
  });

  it('treats count units as one each', () => {
    expect(toBaseQuantity(12, 'EACH').baseQuantity).toBe(12);
    expect(dimensionOf('PACK')).toBe('COUNT');
  });

  it('converts within a dimension', () => {
    expect(convert(1000, 'G', 'KG')).toBe(1);
    expect(convert(2, 'L', 'ML')).toBe(2000);
  });

  it('refuses cross-dimension conversion', () => {
    expect(() => convert(1, 'CUP', 'G')).toThrow(/cross-dimension/);
  });
});
