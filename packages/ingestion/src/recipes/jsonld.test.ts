import { describe, it, expect } from 'vitest';
import {
  findRecipeNode,
  mapJsonLdRecipe,
  parseIsoDurationMinutes,
  extractJsonLdBlocks,
} from './jsonld.js';

const FIXTURE = {
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'WebSite', name: 'Some Food Blog' },
    {
      '@type': 'Recipe',
      name: 'Classic Lasagna',
      image: { '@type': 'ImageObject', url: 'https://example.com/lasagna.jpg' },
      recipeYield: '8 servings',
      prepTime: 'PT30M',
      cookTime: 'PT1H',
      recipeCuisine: ['Italian'],
      recipeCategory: 'Dinner',
      keywords: 'pasta, baked, comfort food',
      aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.7', ratingCount: '1523' },
      recipeIngredient: ['1 lb ground beef', '12 lasagna noodles', '2 cups ricotta'],
      recipeInstructions: [
        { '@type': 'HowToStep', text: 'Brown the beef.' },
        { '@type': 'HowToStep', text: 'Layer and bake.' },
      ],
    },
  ],
};

describe('parseIsoDurationMinutes', () => {
  it('parses hours and minutes', () => {
    expect(parseIsoDurationMinutes('PT1H30M')).toBe(90);
    expect(parseIsoDurationMinutes('PT45M')).toBe(45);
    expect(parseIsoDurationMinutes('garbage')).toBeUndefined();
  });
});

describe('findRecipeNode + mapJsonLdRecipe', () => {
  it('finds the Recipe inside @graph and normalizes it', () => {
    const node = findRecipeNode(FIXTURE);
    expect(node).not.toBeNull();
    const r = mapJsonLdRecipe(node!, 'https://www.example.com/lasagna');
    expect(r.name).toBe('Classic Lasagna');
    expect(r.sourceName).toBe('example.com');
    expect(r.imageUrl).toBe('https://example.com/lasagna.jpg');
    expect(r.servings).toBe(8);
    expect(r.prepMinutes).toBe(90); // prep 30 + cook 60 (no totalTime)
    expect(r.cuisine).toBe('Italian');
    expect(r.category).toBe('Dinner');
    expect(r.tags).toEqual(['pasta', 'baked', 'comfort food']);
    expect(r.externalRating).toBeCloseTo(4.7);
    expect(r.externalRatingCount).toBe(1523);
    expect(r.ingredientLines).toHaveLength(3);
    expect(r.instructions).toContain('1. Brown the beef.');
  });
});

describe('extractJsonLdBlocks', () => {
  it('pulls ld+json scripts out of HTML and skips malformed ones', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"Recipe","name":"X","recipeIngredient":["1 egg"]}</script>
      <script type="application/ld+json">{not json</script>
    </head></html>`;
    const blocks = extractJsonLdBlocks(html);
    expect(blocks).toHaveLength(1);
    expect(findRecipeNode(blocks[0])).not.toBeNull();
  });
});
