# Local UPC corpus, product sourcing & nutrition

The pantry models **containers of ingredients**. Three layers:

- **Ingredient** (`CanonicalItem`) — the store/brand-agnostic concept recipes reference. **Water**
  is the one ingredient with no container: an `assumeStocked` item, metered (piped), never scanned.
- **Product** (`Product`, new) — a store-agnostic **container keyed by UPC**: brand, description,
  net size, serving size, servings-per-container, per-serving **nutrition**, image. This is the
  "local corpus" we call from first. Links up to its ingredient (`canonicalItemId`).
- **Pantry lot** (`InventoryLot`) — a physical container on the shelf: `productId` (the scanned
  UPC), amount remaining, `expiresAt`, brand/location.

Store **price** stays on `ProviderProduct` + `PriceObservation` (per provider), keyed by the same UPC.

## Sourcing & precedence (independent per field-group)

Each `Product` records **where each field-group came from and when** (`descriptionSource` /
`nutritionSource` + timestamps, enum `KROGER | STORE | USDA | OFF | MANUAL`). Two independent
precedence orders (in `apps/api/src/lib/productCorpus.ts`):

| group | order | why |
|-------|-------|-----|
| description / brand / size | **Fry's/Kroger → other stores → Open Food Facts → UPCitemdb** | Fry's is authoritative for the shelf; UPCitemdb is the last-resort long-tail source (great titles + images) but quota-limited, so it's only called when nothing else described the UPC |
| nutrition (per serving) | **USDA FoodData Central → Open Food Facts** | Kroger's API doesn't return nutrition; USDA is authoritative, OFF fills gaps |

**Images** travel with the description group: whichever source is available (Kroger, OFF, or
UPCitemdb) supplies `Product.imageUrl`, backfilled onto the row when it has none. Shown as
thumbnails in the pantry list and the scan-add card.

**Write rule:** a field-group is overwritten only by an **equal-or-higher-priority** source, so
Fry's is never downgraded by OFF, and a re-pull from the same source refreshes in place. `MANUAL`
outranks everything (user edits are never clobbered).

## Resolve flow (`resolveProduct(upc, householdId)`)

1. **Local `Product`** by UPC. If it already has nutrition → return it, **no network** (re-scans are instant).
2. Otherwise fetch in parallel: **Kroger** by UPC (the org's Fry's location + app token) and **OFF**
   (description + nutriments); then **USDA** by UPC, else by name.
3. Merge each field-group by precedence, upsert to the corpus, resolve/link the ingredient, set the
   ingredient's `referenceProductId` (for recipe-nutrition fallback) and default base unit.

Scanning stores the resolved `productId` on the pantry lot and prefills brand + size (+ expiry input).

## Produce PLU codes (loose fruit/veg)

PLUs are the 4-5 digit stickers on **loose produce** (a separate namespace from UPC/EAN) — `4011`
= bananas, a leading `9` = organic (`94011`). They can be **typed** (4-5 digits) or **scanned**:
produce stickers that carry a barcode use **GS1 DataBar** (RSS-14 / RSS-Expanded), enabled in the
scanner alongside UPC/EAN. A DataBar decodes to a zero-padded GTIN embedding the PLU
(`00000000040115` = 4011 + check digit; RSS-Expanded may prefix the `(01)` AI), so `extractPlu`
reduces any decoded value to its PLU and the route checks that **before** the UPC path (a produce
DataBar also passes the 14-digit UPC test). It only matches when the reduction is a real PLU, so
genuine product UPCs are never hijacked.

- The full **IFPS** list (1520 codes) is bundled at `packages/ingestion/src/products/pluCodes.ts`
  (source: github.com/ankane/plu). `resolvePlu` strips the organic `9`, maps to the commodity.
- Loose produce has **no manufactured container**, so the corpus entry is a pseudo-product keyed
  `plu:<code>` with `descriptionSource = IFPS` and **USDA-by-name** nutrition — produce is generic,
  so USDA is exactly right. The by-name picker prefers the *raw/whole* form and avoids processed
  entries (so "Bananas" → raw 89 kcal, not dehydrated 346).
- It's set as the ingredient's `referenceProduct`, so recipes using that produce get nutrition.

**Tap-to-read (vision) — the reliable produce path.** Those micro DataBars decode poorly in a
phone browser. So in the scanner, **tapping the screen** captures the frame, downscales it, and
POSTs to `/items/scan-image`, which runs the local vision LLM (`extractProduceLabel`,
qwen2.5vl) to read the **printed PLU + name** off the sticker. It returns a `code` (the PLU, else
a printed UPC) that feeds the normal resolve pipeline. Verified reading `4012`→Navel and
`3283`→Honeycrisp off real stickers. (Barcode auto-decode still runs continuously for packaged
UPCs; tap is the produce fallback.)
- `Product.servingDimension` records whether a serving is mass/volume/count, so recipe math
  converts correctly (e.g. a USDA 100 g serving vs a recipe's "2 bananas" via the item's density).

## Recipe nutrition — "per specific container/brand"

Recipe nutrition uses the **exact product the household has stocked** for each ingredient (FIFO lot),
falling back to that ingredient's `referenceProduct` when it isn't in the pantry. Amounts convert
recipe base-units → servings via the product's serving size, bridging mass↔volume↔count with the
item's density (`crossConvert`). Recipe detail returns `{ perServing, total, covered, required }`;
the web shows a per-serving panel with a `covered/required` indicator.

Consequence of this choice (vs generic per-ingredient): a recipe only shows nutrition for ingredients
that have a linked product — i.e. that have been **scanned/stocked at least once**. Coverage grows as
the corpus fills. (The rejected alternative would have used generic USDA-by-name profiles for every
ingredient regardless of stock.)

## Config / ops

- **`USDA_FDC_API_KEY`** in `.env` (free key: https://fdc.nal.usda.gov/api-key-signup.html). Falls
  back to the rate-limited `DEMO_KEY`.
- **`UPCITEMDB_KEY`** in `.env` — empty uses the free trial endpoint (~100 lookups/day); set a paid
  key for volume. Because it's last-resort-only, the trial quota stretches a long way.
- Precedence lists live in code (`productCorpus.ts`) — easy to promote to a settings table/UI later.
- The old `CanonicalItem.upcs[]` cache was replaced by `Product` (dropped in the migration); the few
  previously-scanned UPCs re-enrich into the corpus on the next scan.

## Deferred (see `feature-requests.md` #3)

- **Brand preferencing** — learn/prefer the brands an org buys (optimizer + list builder).
- **Feed the corpus from `syncPrices`** — the Kroger price sync should also upgrade `Product`
  description/size to `KROGER` source (the "updates preferenced from Fry's" path, beyond scan-time).
- **Pricing from parsed pack size**; per-lot nutrition/expiry surfaced in the pantry list.
