import { z } from 'zod';
import { unitSchema } from './units.js';

// Types for the time-vs-savings optimizer. Defined here (not in @meals/core) because they
// cross the API boundary: core produces them, the api returns them, the web renders them.

/** One line the shopper needs, expressed in base units. */
export const optimizerItemSchema = z.object({
  itemId: z.string(),
  name: z.string(),
  baseQuantityNeeded: z.number().positive(),
  unit: unitSchema,
});
export type OptimizerItem = z.infer<typeof optimizerItemSchema>;

/** A store, its round-trip visit time, and its price for each item it stocks. */
export const optimizerProviderSchema = z.object({
  providerId: z.string(),
  name: z.string(),
  travelMinutes: z.number().nonnegative(),
  // itemId -> cost to satisfy the full needed base quantity at this store (deal-adjusted,
  // pack-rounded). Omit an item the store does not stock.
  itemCosts: z.record(
    z.string(),
    z.object({
      productId: z.string(),
      cost: z.number().nonnegative(),
    }),
  ),
});
export type OptimizerProvider = z.infer<typeof optimizerProviderSchema>;

export const optimizeRequestSchema = z.object({
  timeValuePerMinute: z.number().nonnegative(),
  maxStores: z.number().int().positive().optional(),
});
export type OptimizeRequest = z.infer<typeof optimizeRequestSchema>;

export const optimizerInputSchema = z.object({
  items: z.array(optimizerItemSchema),
  providers: z.array(optimizerProviderSchema),
  timeValuePerMinute: z.number().nonnegative(),
  maxStores: z.number().int().positive().optional(),
});
export type OptimizerInput = z.infer<typeof optimizerInputSchema>;

/** Where a single item ends up being bought. */
export const itemAssignmentSchema = z.object({
  itemId: z.string(),
  providerId: z.string(),
  productId: z.string(),
  cost: z.number().nonnegative(),
});
export type ItemAssignment = z.infer<typeof itemAssignmentSchema>;

export const storeSubtotalSchema = z.object({
  providerId: z.string(),
  name: z.string(),
  itemCost: z.number().nonnegative(),
  travelMinutes: z.number().nonnegative(),
  timeCost: z.number().nonnegative(),
});
export type StoreSubtotal = z.infer<typeof storeSubtotalSchema>;

/** One shopping strategy (e.g. "single store" vs "two stores") the user can choose. */
export const optimizationOptionSchema = z.object({
  strategy: z.string(),
  assignments: z.array(itemAssignmentSchema),
  storeSubtotals: z.array(storeSubtotalSchema),
  totalMoney: z.number().nonnegative(),
  totalTimeMinutes: z.number().nonnegative(),
  // money + timeValuePerMinute * time — the objective the optimizer minimizes.
  totalObjective: z.number(),
  // money saved vs the single-store baseline (>= 0).
  savingsVsBaseline: z.number(),
  unstockedItemIds: z.array(z.string()),
});
export type OptimizationOption = z.infer<typeof optimizationOptionSchema>;

export const optimizationResultSchema = z.object({
  options: z.array(optimizationOptionSchema),
  recommendedIndex: z.number().int().nonnegative(),
  cheapestPossibleMoney: z.number().nonnegative(),
});
export type OptimizationResult = z.infer<typeof optimizationResultSchema>;
