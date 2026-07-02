import type { NormalizedRecipe } from './types.js';
import { cuisineFromKeywords } from './foodcom.js';

// Mapper for the Epicurious Kaggle dataset (hugodarwood/epirecipes,
// full_format_recipes.json, ~20K recipes). Unlike the Food.com dump, ingredient lines
// carry REAL measurements ("1 cup chopped onion"), plus 0–5 ratings and rich tags.

export interface EpiRecipe {
  title?: string;
  ingredients?: string[];
  directions?: string[];
  categories?: string[];
  rating?: number;
  desc?: string | null;
}

const COURSES = [
  'Dinner', 'Lunch', 'Breakfast', 'Brunch', 'Dessert', 'Appetizer', 'Side',
  'Salad', 'Soup/Stew', 'Cocktail', 'Drink', 'Sauce', 'Condiment',
];

/** Stable id from content so re-imports dedup (dataset has no ids/urls). */
export function epiId(title: string, firstIngredient: string): string {
  let h = 5381;
  const s = `${title}|${firstIngredient}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `epi:${(h >>> 0).toString(36)}`;
}

export function mapEpicuriousRecipe(r: EpiRecipe): NormalizedRecipe | null {
  const name = r.title?.trim().replace(/\s+$/, '');
  const lines = (r.ingredients ?? []).map((l) => l.trim()).filter(Boolean);
  if (!name || lines.length < 2) return null;

  const categories = r.categories ?? [];
  const course = COURSES.find((c) => categories.includes(c));
  const steps = (r.directions ?? []).map((d) => d.trim()).filter(Boolean);

  return {
    name,
    sourceName: 'Epicurious',
    externalId: epiId(name, lines[0]!),
    servings: undefined,
    instructions: steps.length
      ? steps.length === 1
        ? steps[0]
        : steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : undefined,
    cuisine: cuisineFromKeywords(categories),
    category: course,
    tags: categories.filter((c) => c !== course).slice(0, 12),
    externalRating:
      typeof r.rating === 'number' && r.rating > 0
        ? Math.min(5, Math.max(0, r.rating))
        : undefined,
    ingredientLines: lines,
  };
}
