import { describe, it, expect } from 'vitest';
import { normalizeName, similarity, matchLine, buildNormKey } from './matcher.js';

describe('normalizeName', () => {
  it('strips pack/size tokens and punctuation, keeps percentages, sorts tokens', () => {
    expect(normalizeName('Milk 2% 1 gal')).toBe('2% milk');
    expect(normalizeName('Eggs, Large (Dozen)')).toBe('egg large');
  });

  it('builds a brand-inclusive norm key', () => {
    expect(buildNormKey('Flour', 'Great Value')).toContain('flour');
  });
});

describe('similarity', () => {
  it('scores identical normalized names as 1', () => {
    expect(similarity('Milk 2% 1gal', 'MILK 2%')).toBe(1);
  });
  it('scores unrelated names low', () => {
    expect(similarity('flour', 'bananas')).toBeLessThan(0.3);
  });
});

describe('matchLine', () => {
  const candidates = [
    { productId: 'p-milk', text: '2% Milk 1 Gallon' },
    { productId: 'p-eggs', text: 'Large Eggs Dozen' },
    { productId: 'p-flour', text: 'All Purpose Flour 2kg' },
  ];

  it('auto-matches a close line', () => {
    const r = matchLine('MILK 2%', candidates);
    expect(r.productId).toBe('p-milk');
    expect(r.decision).toBe('auto');
  });

  it('proposes new when nothing is close', () => {
    const r = matchLine('Dragonfruit', candidates);
    expect(r.decision).toBe('new');
    expect(r.productId).toBeNull();
  });
});
