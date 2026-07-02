import type { NormalizedRecipe } from './types.js';

// TheMealDB (themealdb.com) — free, keyless recipe API used for backend recipe discovery:
// the user searches by name, we preview results and ingest chosen meals. Fields include
// category, area (cuisine), tags, and images. No ratings (JSON-LD imports carry those).

const BASE = 'https://www.themealdb.com/api/json/v1/1';

interface MealDbMeal {
  idMeal: string;
  strMeal: string;
  strCategory: string | null;
  strArea: string | null;
  strInstructions: string | null;
  strMealThumb: string | null;
  strTags: string | null;
  strSource: string | null;
  [key: string]: string | null; // strIngredient1..20 / strMeasure1..20
}

export interface MealSearchResult {
  externalId: string;
  name: string;
  category?: string;
  cuisine?: string;
  imageUrl?: string;
}

async function getJson(url: string): Promise<{ meals: MealDbMeal[] | null }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`TheMealDB HTTP ${res.status}`);
  return (await res.json()) as { meals: MealDbMeal[] | null };
}

export async function searchMeals(query: string): Promise<MealSearchResult[]> {
  const data = await getJson(`${BASE}/search.php?s=${encodeURIComponent(query)}`);
  return (data.meals ?? []).map((m) => ({
    externalId: m.idMeal,
    name: m.strMeal,
    category: m.strCategory ?? undefined,
    cuisine: m.strArea ?? undefined,
    imageUrl: m.strMealThumb ?? undefined,
  }));
}

function mealToRecipe(m: MealDbMeal): NormalizedRecipe {
  const lines: string[] = [];
  for (let i = 1; i <= 20; i++) {
    const ing = m[`strIngredient${i}`]?.trim();
    if (!ing) continue;
    const measure = m[`strMeasure${i}`]?.trim();
    lines.push(measure ? `${measure} ${ing}` : ing);
  }
  return {
    name: m.strMeal,
    sourceName: 'TheMealDB',
    sourceUrl: m.strSource?.trim() || `https://www.themealdb.com/meal/${m.idMeal}`,
    externalId: m.idMeal,
    imageUrl: m.strMealThumb ?? undefined,
    instructions: m.strInstructions ?? undefined,
    cuisine: m.strArea ?? undefined,
    category: m.strCategory ?? undefined,
    tags: (m.strTags ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    ingredientLines: lines,
  };
}

export async function getMeal(externalId: string): Promise<NormalizedRecipe> {
  const data = await getJson(`${BASE}/lookup.php?i=${encodeURIComponent(externalId)}`);
  const meal = data.meals?.[0];
  if (!meal) throw new Error(`TheMealDB meal ${externalId} not found`);
  return mealToRecipe(meal);
}
