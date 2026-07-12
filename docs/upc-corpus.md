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
`nutritionSource` + timestamps, enum `KROGER | STORE | USDA | OFF | UPCITEMDB | IFPS | MANUAL`). Two independent
precedence orders (in `apps/api/src/lib/productCorpus.ts`):

| group | order | why |
|-------|-------|-----|
| description / brand / size | **Fry's/Kroger → other stores → Open Food Facts → UPCitemdb** | Fry's is authoritative for the shelf; UPCitemdb is the last-resort long-tail source (great titles + images) but quota-limited, so it's only called when nothing else described the UPC |
| nutrition (per serving) | **USDA FoodData Central → Open Food Facts** | Kroger's API doesn't return nutrition; USDA is authoritative, OFF fills gaps |

**Images** strongly prefer **Kroger** (reliable, well-lit shots). `resolveProduct` sets/upgrades to
a Kroger image whenever one is available — replacing a non-Kroger URL and clearing `imageCached` so
it re-downloads — and only uses OFF/UPCitemdb imagery when Kroger has none. Images are stored **per
`Product` row** (each row's `imageUrl` + a local cache file `data/product-images/<upc>.jpg`, served
at `/api/product-images/:upc`), so duplicate rows imply duplicate images. Shown as thumbnails in the
pantry list, scan-add card, and catalog search. (Project preference: Kroger data beats Open Food
Facts, which is a last resort.)

**Write rule:** a field-group is overwritten only by an **equal-or-higher-priority** source, so
Fry's is never downgraded by OFF, and a re-pull from the same source refreshes in place. `MANUAL`
outranks everything (user edits are never clobbered).

## Resolve flow (`resolveProduct(upc, householdId)`)

1. **Local `Product`** — look up BOTH the scanned UPC and its **Kroger key** (see UPC matching
   below) and prefer a `KROGER`-sourced row. Fast-path (no network) only when that row is already
   `KROGER`-named **and** has nutrition; an OFF-named row still gets a Kroger re-check on re-scan.
2. Otherwise fetch in parallel: **Kroger** by UPC (the org's Fry's location + app token) and **OFF**
   (description + nutriments); then **USDA** by UPC, else by name.
3. Merge each field-group by precedence, upsert to the corpus, resolve/link the ingredient, set the
   ingredient's `referenceProductId` (for recipe-nutrition fallback) and default base unit.

Scanning stores the resolved `productId` on the pantry lot and prefills brand + size (+ expiry input).

### UPC matching — the check-digit gotcha

Kroger indexes products by the **UPC-A base without its check digit, zero-padded to 13** — box UPC
`041449403205` → Kroger `0004144940320` (NOT the naive pad `0041449403205`). A barcode scanner emits
a UPC-A as **12 OR 13 digits** (with a leading zero), and neither matched Kroger's form — so scans
used to miss both Kroger live *and* our crawled corpus row and fall back to OFF (wrong name, and
often a *serving* size stored as the pack weight, e.g. cornbread 35 g vs real 425 g).
`krogerProductKey(upc)` (`lib/upcUtil.ts`) normalizes any check-digit-bearing form (12/13/14) by
dropping the check digit and padding to 13; both `getProductByUpc` (live) and `resolveProduct`
(corpus lookup) use it. `scripts/dedup-off-products.ts` merges pre-fix OFF duplicates into their
Kroger twin (repoint `InventoryLot`/`CanonicalItem` refs, delete the OFF row + its orphan image);
OFF rows with no Kroger twin (items Fry's doesn't carry) are kept.

### Size parsing

Fry's returns size as a **string** ("6 cans / 12 fl oz", "12 ct", "1/2 gal"), stored raw as
`sizeText`; `parseQuantityText` (`lib/upcUtil.ts`) derives `packSize`/`packUnit`/`baseQuantity` from
it — handling multipacks (N×M), "N x M", fractions, and count packs (→ EACH), with a `\b` after the
measure alternation so "g" can't match inside "gal". `scripts/reparse-sizes.ts` re-derives the whole
corpus from the stored strings (no API calls) after parser changes.

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

**Tap-to-read — the reliable produce path.** Those micro DataBars decode poorly in a phone
browser. So in the scanner, **tapping the screen** captures the frame, downscales it (1280px), and
POSTs to `/items/scan-image`, which reads the **printed PLU + name** off the sticker and returns a
`code` (the PLU, else a printed UPC) that feeds the normal resolve pipeline. Verified `4012`→Navel,
`3283`→Honeycrisp on real stickers, `via: paddleocr`, <1s. (Barcode auto-decode still runs
continuously for packaged UPCs; tap is the produce path.)

**Reader tiers (`/items/scan-image`), in order:**
1. **PaddleOCR sidecar (default)** — `services/paddleocr` (RapidOCR / PP-OCR ONNX, CPU, no
   paddlepaddle). `lib/produceOcr.ts` gets the text lines, then picks the **4-5 digit token that
   is a real IFPS PLU AND whose commodity matches other printed text** (so a misread "4011" can't
   win on a "NAVEL" sticker). Fast (~0.5s) and precise on digits. Config: `PADDLE_OCR_URL`.
2. **Claude vision** — used if PaddleOCR finds no PLU and `ANTHROPIC_API_KEY` is set (`OCR_MODEL`).
3. **Local vision LLM** (`qwen2.5vl`, `extractProduceLabel`) — final fallback.

Benchmarks (RTX 4060 Ti, real stickers): PaddleOCR ~0.5s; qwen2.5vl:3b 3-4s (accurate on clean
frames, misreads on bad ones); qwen3-vl 4b/8b 5-19s (reasoning — too slow). A name↔PLU consistency
guard on the LLM paths turns a misread into "type the PLU" instead of the wrong item.
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

## Catalog crawl, local images, nutrition backfill (2026-07)

Beyond scan-time enrichment, the corpus is **pre-populated** from Fry's so users can search/build
lists from the whole store and recipes get nutrition:

- **Catalog crawl** (`scripts/crawl-kroger-catalog.ts`) — Kroger has no bulk dump, so it sweeps a
  broad term dictionary (canonical names + a grocery/brand seed + IFPS produce words), paginated,
  deduped via `ingestKrogerProduct`, into `Product`. Reached ~35k products. Resumable checkpoint;
  respects the Products API daily cap. Feeds `Product` at `KROGER` source (the "updates preferenced
  from Fry's beyond scan-time" path).
- **Local images** (`scripts/download-product-images.ts`) — pre-download the medium image per
  product to `data/product-images/<upc>.jpg`, bind-mounted into the api as `PRODUCT_IMAGE_DIR` and
  served read-only. ~1 GB for the full catalog. Trails the crawl (poll-until-quiet, `--once` to
  drain).
- **Nutrition backfill** (`scripts/backfill-nutrition.ts`) — fills per-serving nutrition on the
  products recipe nutrition actually reads (each canonical item's **reference product**) via
  **USDA-by-name → OFF** (Kroger's zero-padded UPCs rarely resolve in USDA/OFF by barcode, but
  by-name has broad coverage). Sweeps by an id cursor (no-data rows aren't retried), paced under the
  FDC ~1000/hr cap, resumable via DB state. This is what lights up recipe/diet calories.
- **Catalog search**: `GET /catalog?q=` (pg_trgm on description/brand) + `POST /shopping-lists/:id/add-product`.

These are host-run background jobs (nohup); a reboot stops them — re-run to resume (all idempotent).

## Config / ops

- **`USDA_FDC_API_KEY`** in `.env` (free key: https://fdc.nal.usda.gov/api-key-signup.html). Falls
  back to the rate-limited `DEMO_KEY`.
- **`UPCITEMDB_KEY`** in `.env` — empty uses the free trial endpoint (~100 lookups/day); set a paid
  key for volume. Because it's last-resort-only, the trial quota stretches a long way.
- Precedence lists live in code (`productCorpus.ts`) — easy to promote to a settings table/UI later.
- The old `CanonicalItem.upcs[]` cache was replaced by `Product` (dropped in the migration); the few
  previously-scanned UPCs re-enrich into the corpus on the next scan.

## Deferred / follow-ups

- **Brand preferencing** — shipped (see `feature-requests.md` #3): `BrandPreference` + list-builder honoring.
- **Feed the corpus from Fry's beyond scan-time** — done via the catalog crawl (above).
- **Nutrition backfill quality** — USDA-by-name is approximate (occasional fuzzy mismatch); a
  UPC-exact pass would be more precise where sources carry the pack UPC.
- **`ProviderProduct` size parsing** — the price/optimizer path still uses `parseIngredientLine`
  (core); give it the same multipack/count handling if pricing quantities look off.
- **Pantry-lot size from a sized product** — when a lot's linked product has a real `packSize`,
  adopt it (a one-off sync did this after the OFF→Kroger dedup; could be a standing cleanup).
