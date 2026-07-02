import { describe, it, expect } from 'vitest';
import { parseIngredientLine, complexityOf } from './ingredients.js';

describe('parseIngredientLine', () => {
  it('parses qty + unit + name', () => {
    expect(parseIngredientLine('2 cups all-purpose flour')).toEqual({
      quantity: 2, unit: 'CUP', name: 'all-purpose flour', optional: false,
    });
  });

  it('handles "of" and mixed fractions', () => {
    const r = parseIngredientLine('1 1/2 cups of milk');
    expect(r.quantity).toBe(1.5);
    expect(r.unit).toBe('CUP');
    expect(r.name).toBe('milk');
  });

  it('handles unicode fractions', () => {
    expect(parseIngredientLine('½ tsp salt').quantity).toBe(0.5);
    expect(parseIngredientLine('1½ tbsp butter').quantity).toBe(1.5);
  });

  it('handles bare counts and no unit', () => {
    const r = parseIngredientLine('3 eggs');
    expect(r).toMatchObject({ quantity: 3, unit: null, name: 'eggs' });
  });

  it('handles metric, glued or spaced', () => {
    expect(parseIngredientLine('500g minced beef')).toMatchObject({
      quantity: 500, unit: 'G', name: 'minced beef',
    });
    expect(parseIngredientLine('500 g minced beef')).toMatchObject({
      quantity: 500, unit: 'G', name: 'minced beef',
    });
  });

  it('flags optional/to-taste and strips trailing clauses', () => {
    const r = parseIngredientLine('Salt, to taste');
    expect(r.optional).toBe(true);
    expect(r.name.toLowerCase()).toContain('salt');
    expect(parseIngredientLine('1 onion, finely chopped').name).toBe('onion');
  });

  it('never returns an empty name', () => {
    expect(parseIngredientLine('Dash').name).toBe('Dash');
  });

  it('takes the lower bound of ranges', () => {
    expect(parseIngredientLine('1-2 cups sugar')).toMatchObject({
      quantity: 1, unit: 'CUP', name: 'sugar',
    });
    expect(parseIngredientLine('2 to 3 tbsp oil')).toMatchObject({
      quantity: 2, unit: 'TBSP', name: 'oil',
    });
  });
});

describe('complexityOf', () => {
  it('buckets by ingredients and prep time', () => {
    expect(complexityOf(4, 15)).toBe('EASY');
    expect(complexityOf(8, 40)).toBe('MEDIUM');
    expect(complexityOf(14, 30)).toBe('HARD');
    expect(complexityOf(5, 90)).toBe('HARD');
  });
});
