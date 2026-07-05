# Feature request board

Backlog of user/beta-tester requests. Status: `idea` → `planned` → `in progress` → `shipped` / `parked`.

| # | Request | From | Status | Effort | Needs schema? |
|---|---------|------|--------|--------|---------------|
| 1 | "Suggested" recipes — household-taste recommendations at top of Recipes | beta tester | **shipped** (2026-07-04) | S–M | no |
| 2 | Scan a UPC with phone camera to add a pantry item | beta tester | **shipped + device-verified** (2026-07-05) | M | `CanonicalItem.upcs[]` |
| 3 | Brand preferencing + richer scanned product data (brand, pack size, better names, pricing) | beta tester | brand-pref still open; corpus+nutrition **shipped** (2026-07-05) | M–L | `Product`, `ProductSource` |

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

## 2. Scan a UPC with the phone camera — SHIPPED 2026-07-04

**Ask:** During pantry entry, scan a product barcode with the phone instead of typing.

**Shipped (PWA, no native app):**
- **Web:** `apps/web/src/components/BarcodeScanner.tsx` — full-screen camera overlay, back camera via `getUserMedia`, decodes UPC-A/UPC-E/EAN-13/EAN-8 with `@zxing/browser` + `@zxing/library` (dynamically imported → own async chunk, ~340 KB, loaded only on tap). Permission-denied + insecure-context handled; always offers a type-the-digits fallback. Wired into the Pantry "Add to pantry" card as a **📷 Scan** button (`Inventory.tsx`); a hit prefills the existing add form (item + unit) so the user just sets the amount and taps Add.
- **API:** `GET /items/barcode/:code` (`apps/api/src/routes/items.ts`) → `lib/barcode.ts#resolveBarcode`: **(1)** our cache (`CanonicalItem.upcs`, instant), **(2)** a matched store listing (`ProviderProduct.upc`, cached forward), **(3)** **Open Food Facts** (free, no key, 5 s timeout) → `resolveCanonicalItem(name)` → UPC cached onto the item. Unknown → `found:false` (manual entry). Invalid barcode → 400.
- **Schema:** `CanonicalItem.upcs String[]` + GIN index — global barcode cache (a UPC identifies the same product everywhere), matching the now-global canonical dictionary.
**Scanner UX, device-verified 2026-07-05** (iterated with the tester on a real iPhone):
- Live-only, **no native camera app**. The preview decodes **continuously in-browser** (zxing on the video frames — nothing uploaded, only the decoded digits are sent). The photo-capture fallback (`<input capture>`) was removed because it launched the system camera, which was confusing.
- iOS fix: set the `<video>` **`muted` property imperatively** — React's `muted` prop is unreliable, and without it iOS won't play the stream, starving the decoder (this was the "nothing scans, no error" bug).
- **Tap-to-scan** backup decodes the current frame locally (no camera app); on-screen text: "Center the barcode — it scans automatically, or tap the screen to scan." Typing digits is the last resort.
- **Continuous stock-as-you-scan:** adding a scanned item reopens the scanner for the next one; only chains for scan-sourced adds.

**Brand + pack size capture (2026-07-05):** `resolveBarcode` now returns OFF `brand` and a parsed `size` (`parseOffQuantity` handles "32 fl oz"/"500 ml"/"33 cl"/"1.5 L"…). The scan flow prefills the pantry lot's **brand** (editable field) and **amount+unit**, and seeds the item's default measurement type from the pack size. OFF names are de-junked (`cleanOffName` drops crowd abbreviations like "imp" → "Vinegar apple cider imp" became "Vinegar Apple Cider"); existing mangled items were renamed. Note: brand/size only enrich on the **first** (OFF) scan — a re-scan hits the `known` cache and returns just the item (brand is per-lot). Many OFF entries (incl. this Heinz vinegar) simply have no `quantity`, so size stays manual there.

**Verified:** OFF lookup (Nutella, Coca-Cola `5449000000996` → brand "Coca-Cola", size 330 ML from "33 cl"), `known` cache hit, invalid → 400, unknown → `found:false`, live.

**Still open → see #3** (brand preferencing, canonical-name quality, pricing from pack size). A native scanner (Phase 3) stays as the durable upgrade for tough lighting/focus.

**Feasible now as a PWA — a native app is NOT required.** iOS Safari supports `getUserMedia` (camera) over HTTPS, and we already serve HTTPS via the Cloudflare tunnel.

- The native `BarcodeDetector` API is **not** available in iOS Safari, so decode in-page with a WASM/JS decoder (**ZXing-wasm** or **quagga2**) reading frames from the live camera stream. Handles UPC-A / EAN-13 (grocery barcodes).
- **Flow:** tap "Scan" on the pantry add form → camera opens (requires a user gesture + HTTPS, iOS 14.3+) → decode UPC → resolve to an item:
  1. Local first: match `ProviderProduct.upc` we already know.
  2. Fallback: **Open Food Facts** (free, no key, grocery-focused) UPC → product name → `resolveCanonicalItem()` → prefill the add form.
  3. Cache the UPC→canonicalItem mapping so the next scan of the same product is instant/offline.

**Why keep a native app on the board anyway:** in-browser decode on iOS can be finicky (focus, low light, autofocus); a native app (React Native, already the Phase-3 plan) gets the reliable system scanner and offline camera. So: ship the **PWA scanner now**, keep **native scanning** as the durable upgrade.

**Effort:** M. Small schema touch only if we persist a UPC→item cache table (or reuse `ProviderProduct.upc` + `IngredientAlias`).

**Open questions:** Open Food Facts coverage for US grocery is decent but not total — unknown UPCs fall back to manual entry (that's fine, it's the current path). Confirm we're OK calling an external API per unknown scan.

---

## 3. Brand preferencing + richer scanned product data — IDEA

**Ask (from the tester, while scanning a Heinz Apple Cider Vinegar 32 fl oz that showed up as "1 Vinegar Apple Cider Imp"):** the lookup drops brand and pack size, the generic name is ugly, and "eventually the system will need to preference brands the end user likes."

**Built 2026-07-05 — local UPC corpus (see `docs/upc-corpus.md`):** new global `Product` entity (UPC → brand/description/size + per-serving nutrition), sourced with **independent precedence** — description Fry's→stores→OFF, nutrition USDA→OFF — recorded per field-group so Fry's is never downgraded. `InventoryLot.productId` links the physical container; `CanonicalItem.referenceProductId` backs recipe nutrition. Recipe nutrition is computed **per specific container/brand** (pantry product → reference product) and shown per serving on recipe detail. USDA FoodData Central + OFF nutrition clients added; Kroger `getProductByUpc` added; `USDA_FDC_API_KEY` env.

**Still open (the actual "preferencing" ask):**

- **Brand preferencing** — learn the brands an org actually buys/keeps (from scanned lots, receipts, cart history) and prefer them when suggesting purchases, matching prices, or building shopping lists. Likely a per-org `BrandPreference (householdId, canonicalItemId?, brand, weight)` learned signal. This is the real feature the tester is asking for; needs schema + a scoring pass in the optimizer/list builder.
- **Canonical-name quality** — OFF `product_name` is crowd-sourced and messy (word order, abbreviations). Consider deriving cleaner generic names from OFF `categories_tags` (e.g. `en:cider-vinegars` → "Cider Vinegar") and a synonym pass, rather than trusting the raw name. Careful not to fragment the canonical dictionary.
- **Pricing from pack size** — the parsed pack size (e.g. 32 fl oz) should flow into `ProviderProduct`/price-per-base-unit so scanned items participate in the optimizer, not just sit in the pantry.
- **Size when OFF lacks it** — fall back to a second source (UPC databases) or infer from category defaults; today it's manual.

**Effort:** M–L; brand preferencing alone is a standalone feature (schema + optimizer integration). Break out when prioritized.
