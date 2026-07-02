import { z } from 'zod';
import { unitSchema, unitDimensionSchema } from './units.js';

// Request/response DTOs. The same zod schemas validate requests in the Fastify api and
// parse responses in the web client — one contract, no drift.

export const cuid = z.string().min(1);
const positive = z.number().positive();
const nonNeg = z.number().nonnegative();

// ---- Providers ----
export const providerCreateSchema = z.object({
  name: z.string().min(1),
  type: z.string().default('grocery'),
  address: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  travelMinutes: z.number().int().nonnegative().optional(),
  travelKm: z.number().nonnegative().optional(),
});
export const providerUpdateSchema = providerCreateSchema.partial();
export type ProviderCreate = z.infer<typeof providerCreateSchema>;
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>;

// ---- Canonical items ----
export const canonicalItemCreateSchema = z.object({
  name: z.string().min(1),
  brand: z.string().optional(),
  category: z.string().optional(),
  packSize: positive.optional(),
  packUnit: unitSchema.optional(),
  baseUnit: unitSchema.optional(),
  baseDimension: unitDimensionSchema.optional(),
  recipeUnit: unitSchema.optional(),
  purchaseUnit: unitSchema.optional(),
});
export const canonicalItemUpdateSchema = canonicalItemCreateSchema.partial();
export type CanonicalItemCreate = z.infer<typeof canonicalItemCreateSchema>;
export type CanonicalItemUpdate = z.infer<typeof canonicalItemUpdateSchema>;

export const itemMergeSchema = z.object({
  sourceItemId: cuid,
  targetItemId: cuid,
});

// ---- Provider products ----
export const providerProductCreateSchema = z.object({
  providerId: cuid,
  canonicalItemId: cuid.optional(),
  rawName: z.string().min(1),
  brand: z.string().optional(),
  sizeText: z.string().optional(),
  packSize: positive.optional(),
  packUnit: unitSchema.optional(),
  upc: z.string().optional(),
  plu: z.string().optional(),
  sku: z.string().optional(),
  url: z.string().url().optional(),
});
export type ProviderProductCreate = z.infer<typeof providerProductCreateSchema>;

// ---- Prices (manual base-entry path) ----
export const priceCreateSchema = z.object({
  providerProductId: cuid,
  price: positive,
  currency: z.string().default('USD'),
  isDeal: z.boolean().default(false),
  dealType: z.string().optional(),
  multiBuyQty: z.number().int().positive().optional(),
  multiBuyPrice: positive.optional(),
  regularPrice: positive.optional(),
  validFrom: z.coerce.date().optional(),
  validTo: z.coerce.date().optional(),
});
export const priceUpdateSchema = priceCreateSchema.partial().omit({ providerProductId: true });
export type PriceCreate = z.infer<typeof priceCreateSchema>;

// ---- Recipes ----
export const recipeIngredientInputSchema = z.object({
  canonicalItemId: cuid.optional(),
  freeText: z.string().optional(),
  quantity: positive,
  unit: unitSchema,
  prepNote: z.string().optional(),
  optional: z.boolean().default(false),
});
export const recipeCreateSchema = z.object({
  name: z.string().min(1),
  servings: z.number().int().positive().default(1),
  instructions: z.string().optional(),
  sourceUrl: z.string().url().optional(),
  prepMinutes: z.number().int().nonnegative().optional(),
  ingredients: z.array(recipeIngredientInputSchema).default([]),
});
export const recipeUpdateSchema = recipeCreateSchema.partial();
export type RecipeCreate = z.infer<typeof recipeCreateSchema>;
export type RecipeIngredientInput = z.infer<typeof recipeIngredientInputSchema>;

// ---- Recipe catalog: search / import / discover / favorite / cook ----
export const recipeSortOptions = [
  'name',
  'rating',
  'popular',
  'newest',
  'complexity',
  'cheapest',
] as const;
export const recipeQuerySchema = z.object({
  q: z.string().optional(), // matches name, tags, and ingredient names
  cuisine: z.string().optional(),
  category: z.string().optional(),
  tag: z.string().optional(),
  complexity: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(),
  favorite: z.coerce.boolean().optional(),
  cookable: z.coerce.boolean().optional(), // only recipes fully coverable from the pantry
  sort: z.enum(recipeSortOptions).default('name'),
  take: z.coerce.number().int().positive().max(200).default(50),
  skip: z.coerce.number().int().nonnegative().default(0),
});
export type RecipeQuery = z.infer<typeof recipeQuerySchema>;

export const recipeImportSchema = z.object({ url: z.string().url() });
export const discoverIngestSchema = z.object({ externalId: z.string().min(1) });
export const cookRecipeSchema = z.object({
  servings: z.number().int().positive().optional(), // defaults to the recipe's servings
});

/** Pantry coverage for one recipe, computed against current inventory. */
export interface RecipeCoverage {
  requiredCount: number; // linked, non-optional ingredients
  satisfiedCount: number; // of those, how many the pantry fully covers
  missing: { name: string; neededBase: number; haveBase: number }[];
  unlinkedCount: number; // free-text ingredients we can't verify against the pantry
  cookable: boolean; // all linked ingredients satisfied (and at least one linked)
  satisfiedItemIds?: string[]; // pantry-covered canonical item ids (drives cook-tonight cost)
}

// ---- Inventory ----
export const inventoryCreateSchema = z.object({
  canonicalItemId: cuid,
  quantity: positive,
  unit: unitSchema,
  location: z.string().optional(),
  purchasedAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional(),
});
export const inventoryUpdateSchema = inventoryCreateSchema.partial().omit({
  canonicalItemId: true,
});
export const inventoryConsumeSchema = z.object({
  canonicalItemId: cuid,
  quantity: positive,
  unit: unitSchema,
});
export type InventoryCreate = z.infer<typeof inventoryCreateSchema>;

// ---- Meal plans ----
export const mealPlanCreateSchema = z.object({
  name: z.string().optional(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
});
export const mealPlanEntryCreateSchema = z.object({
  recipeId: cuid,
  date: z.coerce.date().optional(), // omitted = staged/unassigned
  slot: z.string().default('dinner'),
  servingsPlanned: z.number().int().positive().default(1),
});

/** Stage a recipe into the current plan as unassigned. */
export const stageRecipeSchema = z.object({
  recipeId: cuid,
  servings: z.number().int().positive().optional(),
  slot: z.string().default('dinner'),
});

/** Assign a staged entry to one or more concrete dates. */
export const assignEntrySchema = z.object({
  dates: z.array(z.coerce.date()).min(1).max(31),
});

/** Patch an entry: move it (date / null = unassigned) and/or rescale servings. */
export const moveEntrySchema = z
  .object({
    date: z.coerce.date().nullable().optional(),
    servingsPlanned: z.number().int().positive().max(99).optional(),
  })
  .refine((v) => v.date !== undefined || v.servingsPlanned !== undefined, {
    message: 'Provide date and/or servingsPlanned',
  });

// ---- Recurring meals ----
export const repeatKinds = ['RANDOM_WEEKLY', 'RANDOM_MONTHLY', 'DAILY', 'WEEKLY', 'MONTHLY'] as const;
export const mealRuleCreateSchema = z
  .object({
    recipeId: cuid,
    kind: z.enum(repeatKinds),
    weekday: z.number().int().min(0).max(6).optional(), // WEEKLY
    dayOfMonth: z.number().int().min(1).max(31).optional(), // MONTHLY
    slot: z.string().default('dinner'),
    servings: z.number().int().positive().optional(),
  })
  .refine((r) => r.kind !== 'WEEKLY' || r.weekday != null, {
    message: 'weekday required for WEEKLY',
  })
  .refine((r) => r.kind !== 'MONTHLY' || r.dayOfMonth != null, {
    message: 'dayOfMonth required for MONTHLY',
  });
export type MealRuleCreate = z.infer<typeof mealRuleCreateSchema>;
export type MealPlanCreate = z.infer<typeof mealPlanCreateSchema>;
export type MealPlanEntryCreate = z.infer<typeof mealPlanEntryCreateSchema>;

/** Auto-generate a week (or N days) of meals from the recipe catalog. */
export const generateMealPlanSchema = z.object({
  startDate: z.coerce.date().optional(), // default: today
  days: z.number().int().min(1).max(14).default(7),
  slot: z.string().default('dinner'),
  preferPantry: z.boolean().default(true), // boost recipes coverable from inventory
  favoritesFirst: z.boolean().default(true),
  budget: z.boolean().default(false), // weight real cost + promos heavily ("cheap week")
});
export type GenerateMealPlan = z.infer<typeof generateMealPlanSchema>;

// ---- Shopping lists ----
export const shoppingListCreateSchema = z.object({
  name: z.string().optional(),
  mealPlanId: cuid.optional(),
});

/** "I'm going to the grocery store" — build a list for the next N days of queued meals. */
export const shopFromQueueSchema = z.object({
  days: z.number().int().min(1).max(30).default(7),
});
export const shoppingListItemUpdateSchema = z.object({
  assignedProviderId: cuid.nullish(),
  chosenProductId: cuid.nullish(),
  status: z.enum(['pending', 'bought', 'skipped']).optional(),
});
export type ShoppingListCreate = z.infer<typeof shoppingListCreateSchema>;

// ---- Costco price import (bookmarklet paste) ----
export const costcoImportSchema = z.object({
  source: z.string().optional(),
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        price: z.number().positive(),
        itemNumber: z.string().optional(),
        size: z.string().optional(),
      }),
    )
    .min(1)
    .max(1000),
});
export type CostcoImport = z.infer<typeof costcoImportSchema>;

/** Mobile quick price capture: type/paste the price you see at a store for one item. */
export const quickPriceSchema = z.object({
  canonicalItemId: cuid,
  price: z.number().positive(),
  size: z.string().optional(), // e.g. "4 lb", "2 L" — enables proportional costing
  brand: z.string().optional(),
});
export type QuickPrice = z.infer<typeof quickPriceSchema>;

/** Parse one pasted product blurb into brand/size/price for a known item. */
export const parsePriceOneSchema = z.object({
  text: z.string().min(1).max(5000),
  itemName: z.string().optional(), // context: what the product is
});
export const parsedPriceOneSchema = z.object({
  brand: z.string().optional(),
  size: z.string().optional(),
  price: z.number().positive().optional(),
});
export type ParsedPriceOne = z.infer<typeof parsedPriceOneSchema>;

/** Free-form paste → LLM parses into {name, size, price} rows. */
export const parsePricesSchema = z.object({ text: z.string().min(1).max(20000) });
export const parsedPriceSchema = z.object({
  name: z.string().min(1),
  price: z.number().positive(),
  size: z.string().optional(),
  itemNumber: z.string().optional(),
});
export type ParsedPrice = z.infer<typeof parsedPriceSchema>;

/** Save parsed/edited price rows to a provider. */
export const bulkPricesSchema = z.object({
  items: z.array(parsedPriceSchema).min(1).max(500),
});

// ---- Settings ----
export const settingsUpdateSchema = z.object({
  name: z.string().optional(),
  currency: z.string().optional(),
  homeLat: z.number().nullish(),
  homeLng: z.number().nullish(),
  timeValuePerMinute: nonNeg.optional(),
});
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

// ---- Review queue ----
export const reviewResolveSchema = z.object({
  action: z.enum(['confirm', 'reject', 'new']),
  // For confirm: the product to attribute this line to.
  providerProductId: cuid.optional(),
  // For "new": create a canonical item + product from the line.
  canonicalItemId: cuid.optional(),
});
export type ReviewResolve = z.infer<typeof reviewResolveSchema>;
