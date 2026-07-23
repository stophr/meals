import { describe, expect, it } from 'vitest';
import { krogerProductKey, normalizeUpc, upcLookupForms } from './barcode.js';

describe('normalizeUpc', () => {
  it('accepts the four scanner forms', () => {
    expect(normalizeUpc('041449403205')).toBe('041449403205'); // UPC-A
    expect(normalizeUpc('0041449403205')).toBe('0041449403205'); // EAN-13
    expect(normalizeUpc('00041449403205')).toBe('00041449403205'); // GTIN-14
    expect(normalizeUpc('04252614')).toBe('04252614'); // UPC-E
  });

  it('strips separators and whitespace', () => {
    expect(normalizeUpc(' 0414-4940-3205 ')).toBe('041449403205');
  });

  it('rejects lengths no scanner emits', () => {
    expect(normalizeUpc('04144940320')).toBeNull(); // 11 — not a real scanner output
    expect(normalizeUpc('4144940320')).toBeNull(); // 10
    expect(normalizeUpc('0414494032050')).toBe('0414494032050'); // 13 stays 13
    expect(normalizeUpc('')).toBeNull();
    expect(normalizeUpc('abc')).toBeNull();
  });
});

describe('krogerProductKey', () => {
  it('maps every check-digit form of the same product to one key', () => {
    expect(krogerProductKey('041449403205')).toBe('0004144940320'); // UPC-A 12
    expect(krogerProductKey('0041449403205')).toBe('0004144940320'); // EAN-13
    expect(krogerProductKey('00041449403205')).toBe('0004144940320'); // GTIN-14
  });

  it('expands UPC-E to UPC-A before keying', () => {
    // Published pair: UPC-E 04252614 ↔ UPC-A 042100005264.
    expect(krogerProductKey('04252614')).toBe('0004210000526');
    expect(krogerProductKey('042100005264')).toBe('0004210000526'); // same key from the UPC-A form
  });

  it('covers every UPC-E expansion branch (last data digit selects the pattern)', () => {
    expect(krogerProductKey('01234505')).toBe(krogerProductKey('012000003455')); // d6=0
    expect(krogerProductKey('01234525')).toBe(krogerProductKey('012200003455')); // d6=2
    expect(krogerProductKey('01234535')).toBe(krogerProductKey('012300000455')); // d6=3
    expect(krogerProductKey('01234545')).toBe(krogerProductKey('012340000055')); // d6=4
    expect(krogerProductKey('01234595')).toBe(krogerProductKey('012345000095')); // d6=9
  });

  it('returns null for EAN-8 (number system not 0/1) and keyless lengths', () => {
    expect(krogerProductKey('96385074')).toBeNull(); // EAN-8
    expect(krogerProductKey('04144940320')).toBeNull(); // 11
    expect(krogerProductKey('')).toBeNull();
  });
});

describe('upcLookupForms', () => {
  it('returns scanned form plus corpus key', () => {
    expect(upcLookupForms('041449403205')).toEqual(['041449403205', '0004144940320']);
  });

  it('collapses when the key equals the input', () => {
    expect(upcLookupForms('04144940320')).toEqual(['04144940320']); // 11-digit: no key
  });
});
