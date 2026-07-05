# Feature request board

Backlog of user/beta-tester requests. Status: `idea` → `planned` → `in progress` → `shipped` / `parked`.

| # | Request | From | Status | Effort | Needs schema? |
|---|---------|------|--------|--------|---------------|
| 1 | "Suggested" recipes — household-taste recommendations at top of Recipes | beta tester | **shipped** (2026-07-04) | S–M | no |
| 2 | Scan a UPC with phone camera to add a pantry item | beta tester | planned | M | small (barcode→item cache) |

---

## 1. "Suggested" recipes (household-taste recommendations) — SHIPPED 2026-07-04

**Ask:** Recipes list should open with a "Suggested" section based on what the household seems to like.

**Shipped:** `GET /recipes/suggested` (`apps/api/src/routes/recipes.ts`) + a "✨ Suggested for you" horizontal shelf at the top of the Recipes catalog view (`apps/web/src/pages/Recipes.tsx`), shown only in the default unfiltered view. Content-based: learns cuisine/category/tag affinity from the org's favorites (weight 3) + planned recipes (weight 1), scores the visible corpus by affinity + pantry-cookable + rating, excludes already-favorited, jitter for freshness. Cold-start orgs get `reason: "popular"` (well-rated shared recipes). Verified both branches live. Refactored the recipe-row decoration (pantry coverage + subs + fav + cost) into a shared `decorateRecipe()`/`loadDecorCtx()` reused by the list and suggested routes.

**Follow-ups if we want more:** per-org cook state (deferred migration) would add a strong "you cook this a lot" weight; collaborative signals across orgs; "because you liked X" explainers on each card.

**Feasible now — no new data needed.** We already hold per-org taste signals:

- `RecipeFavorite` (householdId, recipeId) — explicit likes
- `MealPlanEntry` history — what the org actually plans/cooks
- `InventoryLot` (pantry) — what they can cook *right now*
- `Recipe.cuisine / category / tags / complexity` — the content dimensions to match on
- `IngredientSubstitution` — standing preferences

**Approach (content-based, reuses existing scoring):** The meal-plan generator already scores a candidate pool (`apps/api/src/routes/mealPlans.ts:375`) by rating × confidence + favorites + pantry coverage + cost. Extract that into a shared `scoreRecipesForHousehold()` and expose `GET /recipes/suggested`:

1. Learn a **taste profile** per org: weight cuisines / categories / tags by how often they appear in the org's favorites + planned recipes.
2. Score every visible recipe: `taste-affinity + pantry-cookable bonus + rating − already-shown penalty`, exclude already-favorited (or float them), add mild jitter so the shelf refreshes.
3. Web: a "Suggested for you" carousel above the Recipes grid; empty-state (new org, no signal) falls back to top-rated / cookable-now.

**Caveat:** `timesCooked` / `lastCookedAt` are still **global** on `Recipe` (per-org cook state is a deferred migration), so cook-frequency isn't a per-org signal yet — favorites + meal-plan history carry the taste signal for now. When per-org cook state lands, fold it in as a strong weight.

**Effort:** S–M. No schema change → safe to build even while the crawl runs.

---

## 2. Scan a UPC with the phone camera

**Ask:** During pantry entry, scan a product barcode with the phone instead of typing.

**Feasible now as a PWA — a native app is NOT required.** iOS Safari supports `getUserMedia` (camera) over HTTPS, and we already serve HTTPS via the Cloudflare tunnel.

- The native `BarcodeDetector` API is **not** available in iOS Safari, so decode in-page with a WASM/JS decoder (**ZXing-wasm** or **quagga2**) reading frames from the live camera stream. Handles UPC-A / EAN-13 (grocery barcodes).
- **Flow:** tap "Scan" on the pantry add form → camera opens (requires a user gesture + HTTPS, iOS 14.3+) → decode UPC → resolve to an item:
  1. Local first: match `ProviderProduct.upc` we already know.
  2. Fallback: **Open Food Facts** (free, no key, grocery-focused) UPC → product name → `resolveCanonicalItem()` → prefill the add form.
  3. Cache the UPC→canonicalItem mapping so the next scan of the same product is instant/offline.

**Why keep a native app on the board anyway:** in-browser decode on iOS can be finicky (focus, low light, autofocus); a native app (React Native, already the Phase-3 plan) gets the reliable system scanner and offline camera. So: ship the **PWA scanner now**, keep **native scanning** as the durable upgrade.

**Effort:** M. Small schema touch only if we persist a UPC→item cache table (or reuse `ProviderProduct.upc` + `IngredientAlias`).

**Open questions:** Open Food Facts coverage for US grocery is decent but not total — unknown UPCs fall back to manual entry (that's fine, it's the current path). Confirm we're OK calling an external API per unknown scan.
