# Feature request board

Backlog of user/beta-tester requests. Status: `idea` → `planned` → `in progress` → `shipped` / `parked`.

| # | Request | From | Status | Effort | Needs schema? |
|---|---------|------|--------|--------|---------------|
| 1 | "Suggested" recipes — household-taste recommendations at top of Recipes | beta tester | **shipped** (2026-07-04) | S–M | no |
| 2 | Scan a UPC with phone camera to add a pantry item | beta tester | **shipped + device-verified** (2026-07-05) | M | `CanonicalItem.upcs[]` |
| 3 | Brand preferencing + richer scanned product data (brand, pack size, better names, pricing) | beta tester | **shipped** (2026-07-06) — corpus+nutrition, then brand preferencing + on-the-fly list swaps | M–L | `Product`, `BrandPreference` |
| 4 | Integrate with oven — preheat / set temp+time from a recipe | owner | idea | L | maybe (device link) |
| 5 | Reschedule a locked meal-plan day, or cancel it & return its ingredients to pantry | owner | idea | M | likely (`MealPlanEntry` lock + reservations) |
| 6 | Mark cart as purchased → stock pantry + record prices, close list | owner | idea | M | maybe (`ShoppingList.status`) |
| 7 | Staple rebuy thresholds — suggest/auto-add when a staple drops below a min | owner | idea | M | yes (`StapleThreshold`) |
| 8 | Default expiration numbers — auto-fill shelf life on pantry add | owner | idea | S–M | yes (shelf-life per item/category) |
| 9 | Chatbot — natural-language "text to operation" over the API | owner | idea | L | no (LLM tool-calls existing endpoints) |
| 10 | Gamify recipe sharing & adoption | owner | idea | M–L | yes (points/badges/share attribution) |
| 11 | Gamify LLM/voice features (talking to the app) | owner | idea | M | yes (shared gamification) |
| 12 | Check off list items while shopping | owner | idea | S | no (reuse item `status`) |
| 13 | Add one-off items / staples to a list | owner | idea | S | maybe (household staples set) |
| 14 | Generate shopping list by appending to locked days (not replacing) | owner | idea | M | ties to #5 |
| 15 | Integrate with Siri & Alexa (voice) | owner | idea | L | no (Shortcuts + Alexa skill + token) |
| 16 | Diet option — personalized regimen from age, activity level & taste profile | owner (multiple requests) | **Phase 1 shipped** (2026-07-08) — profile + targets; RD to review styles | L | `DietProfile`, `DietStyle` |

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

**Brand preferencing shipped 2026-07-06:** `BrandPreference (householdId, canonicalItemId, brand)` — per-org preferred brand per ingredient. Shopping-list product selection (`lib/shoppingOptions.ts` `bestOption`) prefers the brand's cheapest option, falling back to cheapest overall with a `preferredBrandUnavailable` flag. On-the-fly swap on the shopping list: pick an option or **scan a UPC** (`POST /shopping-lists/:id/items/:itemId/substitute`), which sets the chosen product + price and **always saves the brand as the standing preference**. Prices from the org's connected stores only. Manage via `GET/DELETE /brand-preferences`. Verified: substituting Smoked Gouda→Murray's saved the pref and auto-select then honored it over the cheaper brand. (Also: fixed a QC Hunts org that had no store/prices by cloning Root's Fry's — prices are per-org.)

**Still open (nice-to-haves):**

- **Brand preferencing** — learn the brands an org actually buys/keeps (from scanned lots, receipts, cart history) and prefer them when suggesting purchases, matching prices, or building shopping lists. Likely a per-org `BrandPreference (householdId, canonicalItemId?, brand, weight)` learned signal. This is the real feature the tester is asking for; needs schema + a scoring pass in the optimizer/list builder.
- **Canonical-name quality** — OFF `product_name` is crowd-sourced and messy (word order, abbreviations). Consider deriving cleaner generic names from OFF `categories_tags` (e.g. `en:cider-vinegars` → "Cider Vinegar") and a synonym pass, rather than trusting the raw name. Careful not to fragment the canonical dictionary.
- **Pricing from pack size** — the parsed pack size (e.g. 32 fl oz) should flow into `ProviderProduct`/price-per-base-unit so scanned items participate in the optimizer, not just sit in the pantry.
- **Size when OFF lacks it** — fall back to a second source (UPC databases) or infer from category defaults; today it's manual.

**Effort:** M–L; brand preferencing alone is a standalone feature (schema + optimizer integration). Break out when prioritized.

---

# New requests (2026-07) — details

Twelve requests from the owner. Grouped by theme; several share dependencies (noted). All `idea` status — this captures the ask + a first-pass approach, not a committed design.

## Cluster A — Meal-plan control & list generation (#5, #14, feeds from #7)

The through-line: meal-plan days can be **locked** (committed), and locking should drive inventory + list behavior.

- **#5 — Reschedule or cancel a locked day.** Move a locked `MealPlanEntry` to another date, or cancel it and **return its reserved ingredients to the pantry**. Implies days can be locked and that locking *reserves* inventory (decrements available, or tags lots as committed). Reschedule = change the date, keep the reservation. Cancel = release the reservation back to `InventoryLot`. Needs: `MealPlanEntry.locked` (or a status enum) + a reservation model (either a `Reservation` join or a committed flag on lots). This is the anchor for the cluster.
- **#14 — Generate list appending to locked days.** `generate-list` should **append** the ingredients required by locked days onto the existing shopping list instead of replacing it (aggregate needs − pantry − already-on-list). Depends on #5's locking. Today `POST /meal-plans/:id/generate-list` builds a fresh list; add an append/merge mode keyed to locked entries.
- Sequencing: build **#5 (locking + reservation)** first; **#14** and the staple flow (#7) then plug into it.

## Cluster B — Shopping completion (#6, #12, #13)

Closing the loop from "list" → "bought" → "pantry."

- **#12 — Check off list items while shopping.** Tap to mark an item bought as you walk the store. `ShoppingListItem.status` already exists (`pending`) — mostly a web interaction (checkbox + struck-through row + a "bought / remaining" count) + a `PATCH` to flip status. Smallest of the set; good warm-up.
- **#6 — Mark cart as purchased.** One action to finalize a shopping trip: **stock the pantry** (create `InventoryLot`s from the checked/selected products, with pack size → quantity), **record prices** (the chosen options become `PriceObservation`s), and close/archive the list. Inverse of the existing `POST /inventory/consume` (FIFO deduct on cook). Needs a `purchased` state + the stock-on-purchase transaction. Pairs with #12 (check-off decides what actually got bought) and #8 (default expirations set the new lots' `expiresAt`).
- **#13 — Add one-off items / staples.** Quick-add ad-hoc items (milk, paper towels) to a list without a recipe/plan. We already have `POST .../items` (typeahead) and `add-product` (catalog). This is mostly a **saved "staples" set** per household surfaced as one-tap chips ("＋ Milk ＋ Eggs ＋ Bread"). Overlaps with #7 (staples are the same entities that get rebuy thresholds).

## Cluster C — Pantry automation (#7, #8)

- **#8 — Default expiration numbers.** Auto-fill `InventoryLot.expiresAt` on pantry add from a default shelf-life. Store per-item (`CanonicalItem.defaultShelfLifeDays`) with a category fallback table; seed sensible defaults (produce ~7d, dairy ~14d, canned ~2y). Small, high-value for the expiry-driven consume logic that already exists.
- **#7 — Staple rebuy thresholds.** Mark items as staples with a **minimum on-hand** (e.g. "always ≥ 1 gal milk"); when pantry drops below (via consume or a purchased-cart update), **suggest a rebuy** or auto-add to the active/next list. Needs `StapleThreshold (householdId, canonicalItemId, minQty, unit)` + a check that runs after inventory changes. Feeds Cluster A/B (the suggestions land on a list).

## Cluster D — Conversational & voice (#9, #11, #15)

All three are the same core: **map natural language → API operations**, then surface it through different front-ends.

- **#9 — Chatbot ("text to operation").** An LLM with **tool-calling** over our existing endpoints ("add milk to my list", "what can I cook tonight", "mark the cart purchased"). We already run a local LLM (Ollama qwen2.5) + optional Anthropic. Build a tool-schema layer that whitelists safe operations + confirms mutations. No new domain schema — it drives existing routes. This is the foundation for #11 and #15.
- **#15 — Siri & Alexa.** Voice front-ends onto #9's operation layer: **iOS Siri Shortcuts** can call our API directly (per-household token); an **Alexa skill** needs account-linking + an endpoint. Needs a stable auth token for headless callers. Build after #9 so both share one intent→operation core.
- **#11 — Gamify talking to the app.** Rewards for using the chatbot/voice (streaks, "power user" badges). Depends on #9 existing + Cluster E's gamification substrate.

## Cluster E — Gamification (#10, #11)

- **#10 — Gamify recipe sharing & adoption.** Points/badges when a recipe you shared gets **adopted** (favorited/cooked) by other households. Needs share attribution (who introduced a recipe), an adoption signal, and a points/achievements model — cross-org, so it touches the shared recipe corpus + a new `Achievement`/`Points` layer.
- **#11** (also above) reuses that substrate for LLM/voice engagement. Build the **points/achievements core once** (Cluster E), then #10 and #11 are events into it.

## Standalone — Hardware (#4)

- **#4 — Oven integration.** Send a recipe's temp/time to a smart oven (preheat, set mode/timer). Gated by **oven-brand APIs** (GE SmartHQ, June, Samsung SmartThings, etc.) — each is a separate OAuth + device integration, and coverage is spotty. Likely the largest/riskiest and most external-dependency-bound item; keep as a stretch until a specific oven brand is in play. A brand-agnostic "send to oven" abstraction over one integration first.

## Cluster F — Nutrition & diet (#16)

- **#16 — Diet option (personalized regimen).** Multiple users have asked for a recommended eating regimen tailored to **age, activity level, and taste profile**. This is a strong fit for what we already have: **per-serving recipe nutrition** (from the `Product`/nutrition corpus + recipe nutrition compute), **taste-profile learning** (the #1 suggested-recipes engine already weights cuisine/category/tags from favorites + meal-plan history), and **meal-plan generation**.

  **Approach (phased):**
  1. **Profile + targets.** Collect age, sex, height, weight, activity level, and a goal (maintain / lose / gain). Compute a daily **calorie target** (Mifflin–St Jeor BMR × activity multiplier ± goal delta) and a **macro split** by chosen diet style (balanced / high-protein / Mediterranean / low-carb / etc.). Show the targets.
  2. **Recommend to targets.** Filter/rank the recipe corpus by fit to the calorie/macro targets **and** taste affinity (reuse `decorateRecipe`/suggested scoring) — "meals that fit your day and your taste."
  3. **Generate a regimen.** Produce a day/week meal plan whose per-serving nutrition sums toward the targets (extend `generate-list`/meal-plan generation with a nutrition-aware objective), which then flows into shopping lists.

  **Schema:** `DietProfile` keyed **per User** (age/activity/goal are personal), not per household — but meal planning is household-level, so multi-person households need a reconciliation strategy (per-person servings/targets, or plan for a chosen member, or aggregate). Store computed targets (calories + macro grams) on the profile so scoring is cheap. Ties to [[tenancy-architecture]] (Users exist under Household).

  **Guardrail:** this is health-adjacent — present as **general guidance, not medical/clinical advice**, with a visible disclaimer; avoid diagnosis/medical claims and let users override targets. LLM (#9) could gather the profile conversationally, but the calorie/macro math should be deterministic (formula), not model-guessed.

  **Effort:** L. Phase 1 (profile + targets) is self-contained and shippable alone; phases 2–3 build on existing suggested-recipes + meal-plan machinery.

  **Phase 1 — SHIPPED 2026-07-08.** `DietProfile` (per user: birthYear/sex/heightCm/weightKg/activityLevel/goal + cached targets) and `DietStyle` (seedable macro presets). `lib/dietTargets.ts` computes calories (Mifflin–St Jeor × activity ± goal delta, sex-based floor) + macro grams from the chosen style. `GET /diet-styles`, `GET/POST /diet-profile` (per current user via `getPrincipal`). Web: a "🥗 Your diet profile" panel in Settings (US units in, metric stored) that shows the calorie + P/C/F targets with a not-medical-advice disclaimer. Verified: 35yo male, 5'10", 180 lb, moderate, maintain, high-protein → 2720 kcal / 238P·272C·76F (matches hand-calc).

  **For the RD:** the reviewable content is the 7 seeded `DietStyle` rows (macro %, name, description, `notes`) plus the goal deltas + calorie floors in `lib/dietTargets.ts` (`GOAL_DELTA`, `CALORIE_FLOOR`). All styles seed `rdReviewed=false`; the seed script preserves a row's numbers once `rdReviewed=true` so her edits aren't clobbered on re-seed. Provisional splits: Balanced 20/50/30, High-Protein 35/40/25, Lower-Carb 30/25/45, Keto 20/5/75, Mediterranean 20/45/35, Plant-Based 18/55/27, Performance 25/50/25.

  **Phase 2–3 (open):** rank recipes to targets + taste; generate a nutrition-aware meal plan; multi-person household reconciliation.

## Rough build order (dependency-aware, when prioritized)

1. **#12** (check-off) — small, self-contained, immediate value.
2. **#8** (default expirations) — small, feeds #6.
3. **#5** (locked-day locking + reservations) — anchors #14.
4. **#6** (mark purchased → stock pantry + prices) — uses #8/#12.
5. **#7** (staple thresholds) + **#13** (staples quick-add) — share the staples entity.
6. **#14** (append to locked days) — needs #5.
7. **#9** (chatbot operation layer) → **#15** (Siri/Alexa) on top.
8. **Cluster E core** → **#10**, **#11**.
9. **#4** (oven) — stretch, external-API-bound.
