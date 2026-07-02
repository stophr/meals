// Normalized recipe shape every recipe source (JSON-LD import, TheMealDB, future providers)
// maps into. The api layer turns this into DB rows via the shared ingredient parser + matcher.

export interface NormalizedRecipe {
  name: string;
  sourceName: string; // provider or site host, e.g. "TheMealDB", "allrecipes.com"
  sourceUrl?: string;
  externalId?: string; // provider-specific id for dedup
  imageUrl?: string;
  servings?: number;
  prepMinutes?: number;
  instructions?: string;
  cuisine?: string;
  category?: string;
  tags: string[];
  externalRating?: number; // normalized to 0..5
  externalRatingCount?: number;
  /** Raw ingredient lines exactly as the source lists them ("2 cups flour"). */
  ingredientLines: string[];
}
