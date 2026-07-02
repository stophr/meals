import { describe, it, expect } from 'vitest';
import { reconcile, formatImperial, baseToGrams, imperializeText, crossConvert } from '@meals/shared';

describe('density bridge', () => {
  const sugar = { gramsPerMl: 0.85, gramsPerEach: null };

  it('a 5 lb bag (weight) covers 2 cups (volume) of sugar', () => {
    const fiveLbGrams = 5 * 453.592; // ~2268 g
    const twoCupsMl = 2 * 236.588; // ~473 ml
    const r = reconcile(twoCupsMl, 'VOLUME', [{ base: fiveLbGrams, dim: 'MASS' }], sugar);
    expect(r.covered).toBe(true);
    expect(r.shortfallBase).toBe(0);
  });

  it('reports the shortfall in the need dimension when stock is short', () => {
    const oneCupMl = 236.588;
    const halfCupGrams = 0.5 * 236.588 * 0.85; // half a cup, as weight
    const r = reconcile(oneCupMl, 'VOLUME', [{ base: halfCupGrams, dim: 'MASS' }], sugar);
    expect(r.covered).toBe(false);
    expect(r.shortfallBase).toBeCloseTo(0.5 * 236.588, 1); // ~half a cup still needed
  });

  it('falls back to same-dimension when no density is known', () => {
    const none = { gramsPerMl: null, gramsPerEach: null };
    const r = reconcile(200, 'VOLUME', [{ base: 500, dim: 'MASS' }], none);
    expect(r.covered).toBe(false); // weight can't cover volume without density
    expect(r.shortfallBase).toBe(200);
  });

  it('count bridges to weight via gramsPerEach', () => {
    const egg = { gramsPerMl: null, gramsPerEach: 50 };
    expect(baseToGrams(3, 'COUNT', egg)).toBe(150);
    const r = reconcile(150, 'MASS', [{ base: 3, dim: 'COUNT' }], egg);
    expect(r.covered).toBe(true);
  });
});

describe('crossConvert (pricing bridge)', () => {
  const sugar = { gramsPerMl: 0.85, gramsPerEach: null };

  it('is identity within a dimension (no factor needed)', () => {
    expect(crossConvert(500, 'MASS', 'MASS', {})).toBe(500);
    expect(crossConvert(250, 'VOLUME', 'VOLUME', {})).toBe(250);
  });

  it('prices a volume need from a weight pack: a 2 kg bag as cups of sugar', () => {
    // 2 kg -> ml of sugar = 2000 / 0.85 ≈ 2353 ml ≈ 9.95 cups
    const packMl = crossConvert(2000, 'MASS', 'VOLUME', sugar)!;
    expect(packMl).toBeCloseTo(2352.9, 0);
    // A recipe needing 1 cup (236.6 ml) costs need/packMl of a $4 bag.
    const cost = (236.588 / packMl) * 4;
    expect(cost).toBeCloseTo(0.4, 1);
  });

  it('returns null when no bridge exists', () => {
    expect(crossConvert(500, 'MASS', 'VOLUME', {})).toBeNull();
  });
});

describe('formatImperial', () => {
  it('renders mass as lb/oz', () => {
    expect(formatImperial(453.592, 'MASS')).toBe('1 lb');
    expect(formatImperial(28.3495, 'MASS')).toBe('1 oz');
  });
  it('renders volume as cups/tbsp/tsp with nice fractions', () => {
    expect(formatImperial(236.588, 'VOLUME')).toBe('1 cup');
    expect(formatImperial(118.294, 'VOLUME')).toBe('½ cup');
    expect(formatImperial(14.7868, 'VOLUME')).toBe('1 tbsp');
    expect(formatImperial(4.92892, 'VOLUME')).toBe('1 tsp');
  });
  it('renders count plainly', () => {
    expect(formatImperial(3, 'COUNT')).toBe('3');
  });
});

describe('imperializeText', () => {
  it('converts metric tokens in recipe lines, keeping descriptors', () => {
    expect(imperializeText('500g minced beef')).toBe('1.1 lb minced beef');
    expect(imperializeText('250 ml milk, warmed')).toBe('1 cup milk, warmed');
    expect(imperializeText('1 kg potatoes')).toBe('2.2 lb potatoes');
    expect(imperializeText('15 ml olive oil')).toBe('1 tbsp olive oil');
  });
  it('leaves non-metric text alone', () => {
    expect(imperializeText('2 cloves garlic, minced')).toBe('2 cloves garlic, minced');
    expect(imperializeText('1 cup rice')).toBe('1 cup rice');
  });
});
