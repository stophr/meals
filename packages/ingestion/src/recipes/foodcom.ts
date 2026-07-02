import type { NormalizedRecipe } from './types.js';
import { parseIsoDurationMinutes } from './jsonld.js';

// Mapper for the Food.com "Recipes and Reviews" Kaggle dataset (irkaal/foodcom-recipes-and-
// reviews, recipes.csv, ~522K rows). Rows carry pre-aggregated star ratings, ingredient
// quantities+parts as R-style vectors (c("1", "2")), keywords, category, images, and ISO-8601
// durations. This module is pure row→NormalizedRecipe mapping; the streaming/DB work lives in
// the api's import script.

export interface FoodComRow {
  RecipeId: string;
  Name: string;
  CookTime?: string;
  PrepTime?: string;
  TotalTime?: string;
  Description?: string;
  Images?: string;
  RecipeCategory?: string;
  Keywords?: string;
  RecipeIngredientQuantities?: string;
  RecipeIngredientParts?: string;
  AggregatedRating?: string;
  ReviewCount?: string;
  RecipeServings?: string;
  RecipeYield?: string;
  RecipeInstructions?: string;
}

/** Parse an R-style character vector: `c("a", "b \"x\"")` | bare string | character(0) | NA. */
export function parseRVector(v: string | undefined | null): string[] {
  if (!v) return [];
  const s = v.trim();
  if (!s || s === 'NA' || s === 'character(0)' || s === 'NULL') return [];
  const inner = s.match(/^c\(([\s\S]*)\)$/);
  if (!inner) {
    // Bare scalar, possibly quoted.
    const bare = s.replace(/^"|"$/g, '').trim();
    return bare && bare !== 'NA' ? [bare] : [];
  }
  const out: string[] = [];
  // Match quoted elements, tolerating \" escapes; NA appears unquoted.
  const re = /"((?:[^"\\]|\\.)*)"|(NA)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner[1]!))) {
    if (m[2] !== undefined) {
      out.push(''); // unquoted NA — keep position so quantities align with parts
    } else {
      out.push(m[1]!.replace(/\\(["\\])/g, '$1').trim());
    }
  }
  return out;
}

const CUISINES = [
  'african', 'american', 'asian', 'australian', 'brazilian', 'cajun', 'canadian', 'caribbean',
  'chinese', 'creole', 'cuban', 'czech', 'danish', 'dutch', 'egyptian', 'english', 'ethiopian',
  'european', 'filipino', 'french', 'german', 'greek', 'hawaiian', 'hungarian', 'indian',
  'indonesian', 'iranian', 'irish', 'italian', 'japanese', 'korean', 'lebanese', 'malaysian',
  'mexican', 'moroccan', 'norwegian', 'pakistani', 'persian', 'peruvian', 'polish',
  'portuguese', 'russian', 'scandinavian', 'scottish', 'southwestern', 'spanish', 'swedish',
  'swiss', 'thai', 'turkish', 'vietnamese', 'welsh',
];

/** Food.com has no cuisine column; derive one from Keywords when a known cuisine appears. */
export function cuisineFromKeywords(keywords: string[]): string | undefined {
  for (const k of keywords) {
    const lower = k.toLowerCase().trim();
    if (CUISINES.includes(lower)) return k.trim();
  }
  return undefined;
}

function num(v: string | undefined): number | undefined {
  if (!v || v === 'NA') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Combine parallel quantity/part vectors into "1 cup flour"-style lines. */
export function ingredientLinesOf(row: FoodComRow): string[] {
  const parts = parseRVector(row.RecipeIngredientParts);
  const quantities = parseRVector(row.RecipeIngredientQuantities);
  return parts
    .map((part, i) => {
      const q = quantities[i]?.trim();
      const p = part.trim();
      if (!p) return '';
      return q && q !== 'NA' ? `${q} ${p}` : p;
    })
    .filter(Boolean);
}

export function mapFoodComRow(row: FoodComRow): NormalizedRecipe | null {
  const name = row.Name?.trim();
  const lines = ingredientLinesOf(row);
  if (!name || lines.length === 0) return null;

  const keywords = parseRVector(row.Keywords);
  const steps = parseRVector(row.RecipeInstructions);
  const rating = num(row.AggregatedRating);

  const prep =
    parseIsoDurationMinutes(row.TotalTime) ??
    ((parseIsoDurationMinutes(row.PrepTime) ?? 0) + (parseIsoDurationMinutes(row.CookTime) ?? 0) ||
      undefined);

  const servings = num(row.RecipeServings) ?? num(row.RecipeYield?.match(/\d+/)?.[0]);

  return {
    name,
    sourceName: 'Food.com',
    sourceUrl: `https://www.food.com/recipe/${row.RecipeId}`,
    externalId: `foodcom:${row.RecipeId}`,
    imageUrl: parseRVector(row.Images)[0],
    servings: servings && servings > 0 && servings < 1000 ? Math.round(servings) : undefined,
    prepMinutes: prep && prep > 0 && prep < 60 * 24 * 8 ? prep : undefined,
    instructions: steps.length
      ? steps.length === 1
        ? steps[0]
        : steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : undefined,
    cuisine: cuisineFromKeywords(keywords),
    category: row.RecipeCategory && row.RecipeCategory !== 'NA' ? row.RecipeCategory.trim() : undefined,
    tags: keywords.slice(0, 12),
    externalRating: rating != null ? Math.min(5, Math.max(0, rating)) : undefined,
    externalRatingCount: num(row.ReviewCount),
    ingredientLines: lines,
  };
}
