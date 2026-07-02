import { describe, it, expect } from 'vitest';
import { rootIngredientName } from './canonicalName.js';

describe('rootIngredientName', () => {
  it('strips leaked measures and prep words', () => {
    expect(rootIngredientName('Pinch Of Sugar')).toBe('Sugar');
    expect(rootIngredientName('Tblsp Caster Sugar')).toBe('Sugar');
    expect(rootIngredientName('Packed Brown Sugar')).toBe('Brown Sugar');
    expect(rootIngredientName('2 cloves garlic, minced')).toBe('Garlic');
    expect(rootIngredientName('Freshly Ground Black Pepper')).toBe('Ground Black Pepper');
  });

  it('maps regional/synonym names to the US buyable name', () => {
    expect(rootIngredientName('Confectioners Sugar')).toBe('Powdered Sugar');
    expect(rootIngredientName('Icing Sugar')).toBe('Powdered Sugar');
    expect(rootIngredientName('Caster Sugar')).toBe('Sugar');
    expect(rootIngredientName('Minced Beef')).toBe('Ground Beef');
    expect(rootIngredientName('Spring Onions')).toBe('Green Onion');
    expect(rootIngredientName('Aubergine')).toBe('Eggplant');
  });

  it('NEVER collapses genuinely different products (safety)', () => {
    expect(rootIngredientName('Sugar Snap Peas')).toBe('Sugar Snap Peas');
    expect(rootIngredientName('Sugar Substitute')).toBe('Sugar Substitute');
    expect(rootIngredientName('Sugar-Free Maple Syrup')).toBe('Sugar-Free Maple Syrup');
    expect(rootIngredientName('Garlic Powder')).not.toBe('Garlic');
    expect(rootIngredientName('Brown Sugar')).not.toBe('Sugar');
  });

  it('is idempotent and stable', () => {
    const once = rootIngredientName('Packed Dark Brown Sugar');
    expect(rootIngredientName(once)).toBe(once);
    expect(rootIngredientName('Sugar')).toBe('Sugar');
  });
});
