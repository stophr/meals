import { describe, it, expect } from 'vitest';
import { parseRVector, cuisineFromKeywords, mapFoodComRow, ingredientLinesOf } from './foodcom.js';

describe('parseRVector', () => {
  it('parses c(...) vectors', () => {
    expect(parseRVector('c("flour", "sugar", "salt")')).toEqual(['flour', 'sugar', 'salt']);
  });
  it('handles escaped quotes and NA elements', () => {
    expect(parseRVector('c("say \\"hi\\"", NA, "x")')).toEqual(['say "hi"', '', 'x']);
  });
  it('handles bare scalars and empties', () => {
    expect(parseRVector('"just one"')).toEqual(['just one']);
    expect(parseRVector('plain')).toEqual(['plain']);
    expect(parseRVector('character(0)')).toEqual([]);
    expect(parseRVector('NA')).toEqual([]);
    expect(parseRVector(undefined)).toEqual([]);
  });
});

describe('cuisineFromKeywords', () => {
  it('finds a known cuisine among keywords', () => {
    expect(cuisineFromKeywords(['Weeknight', 'Mexican', 'Easy'])).toBe('Mexican');
    expect(cuisineFromKeywords(['Weeknight', 'Oven'])).toBeUndefined();
  });
});

const ROW = {
  RecipeId: '38',
  Name: 'Best Blueberry Muffins',
  CookTime: 'PT25M',
  PrepTime: 'PT15M',
  TotalTime: 'PT40M',
  Images: 'c("https://img.sndimg.com/1.jpg", "https://img.sndimg.com/2.jpg")',
  RecipeCategory: 'Quick Breads',
  Keywords: 'c("Breads", "Breakfast", "American", "< 60 Mins")',
  RecipeIngredientQuantities: 'c("1 3/4", "1/3", NA, "2")',
  RecipeIngredientParts: 'c("flour", "sugar", "salt", "eggs")',
  AggregatedRating: '4.5',
  ReviewCount: '272',
  RecipeServings: '12',
  RecipeInstructions: 'c("Mix dry.", "Add wet.", "Bake.")',
};

describe('mapFoodComRow', () => {
  it('maps a full row', () => {
    const r = mapFoodComRow(ROW)!;
    expect(r.name).toBe('Best Blueberry Muffins');
    expect(r.externalId).toBe('foodcom:38');
    expect(r.imageUrl).toBe('https://img.sndimg.com/1.jpg');
    expect(r.prepMinutes).toBe(40);
    expect(r.servings).toBe(12);
    expect(r.cuisine).toBe('American');
    expect(r.category).toBe('Quick Breads');
    expect(r.externalRating).toBe(4.5);
    expect(r.externalRatingCount).toBe(272);
    expect(r.instructions).toBe('1. Mix dry.\n2. Add wet.\n3. Bake.');
  });

  it('pairs quantities with parts, tolerating NA quantities', () => {
    expect(ingredientLinesOf(ROW)).toEqual(['1 3/4 flour', '1/3 sugar', 'salt', '2 eggs']);
  });

  it('rejects rows without name or ingredients', () => {
    expect(mapFoodComRow({ ...ROW, RecipeIngredientParts: 'character(0)' })).toBeNull();
    expect(mapFoodComRow({ ...ROW, Name: '' })).toBeNull();
  });
});
