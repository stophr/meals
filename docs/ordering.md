# Store ordering integrations

Goal: one button compares real prices per store, stages each store's cart, the user approves
and completes checkout in the store's own app (saved payment). **No US grocer allows full
third-party checkout**, so "approve → placed" means: cart pre-filled, one checkout tap per
store, always at first-party prices (no Instacart or other markup middlemen).

## Fry's (Kroger) — official API ✅ implemented

Free [Kroger Developer API](https://developer.kroger.com/) (all Kroger banners incl. Fry's):

| Surface | What we use it for |
|---|---|
| Locations | find the store (`GET /api/integrations/kroger/locations?zip=85142`) |
| Products | **real per-store prices incl. promo** → nightly/on-demand sync into `PriceObservation` (`POST /api/integrations/kroger/sync-prices`) |
| Cart | push staged items into the user's actual Fry's cart (`POST /api/shopping-lists/:id/kroger-cart`) |

Setup:
1. developer.kroger.com → create an Application → copy Client ID + Secret into `.env`
   (`KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET`).
2. Register the redirect URI in the portal: `http://localhost:8090/api/integrations/kroger/callback`
   (add your LAN variant too if you authorize from the phone).
3. Link the store: `GET /api/integrations/kroger/locations?zip=85142` → pick the Fry's →
   `POST /api/providers/:id/link-kroger {locationId}`.
4. Authorize cart pushes once: visit `/api/integrations/kroger/authorize` (Fry's login).
5. Sync prices for a list: `POST /api/integrations/kroger/sync-prices {providerId, shoppingListId}`
   — products match by UPC, deals set `isDeal` + `regularPrice`, prices expire after 7 days
   (the weekly ad cycle). The optimizer then compares real Fry's prices.

Rate limits: 10K product calls/day — far more than a household needs.

## Walmart — documented cart URL + gated price data

- **Cart building (works today, no approval):** Walmart documents an
  [Add-to-Cart URL](https://walmart.io/docs/atc/v1/add-to-cart):
  `https://www.walmart.com/sc/cart/addToCart?items=ITEMID_QTY,…&storeId=…` — opens the
  user's walmart.com cart pre-filled at first-party prices. Implemented in
  `GET /api/shopping-lists/:id/cart-links` (falls back to per-item search links until we
  know Walmart item IDs).
- **Item IDs + price data:** requires [Walmart affiliate / Content Provider API](https://www.walmart.io/docs/affiliate/)
  approval (free, read-only, application-gated) — worth applying. Until then, Walmart prices
  accrue from receipt OCR, and cart links degrade to search links.

## Safeway (Albertsons) — no official API

- **No public API; no cart URL scheme.** Per-item search deep links implemented
  (`safeway.com/shop/search-results.html?q=…`) — tap down the list, add each item.
- **Personal-use automation is a well-trodden path** (user's own account, no middleman):
  e.g. [smkent/safeway-coupons](https://github.com/smkent/safeway-coupons) (auto-clips
  "Safeway for U" offers via a headless session) and
  [giwty/safeway-offers](https://github.com/giwty/safeway-offers) (reads offers via the
  mobile APIs). Two future options on this base, both ToS-gray but personal-scale:
  1. **Deal data**: pull the household's Safeway for U offers into `PriceObservation`
  2. **Cart automation**: Playwright with the household's own login to add list items
- Interim: Safeway price history builds from receipt OCR.

## Explicitly rejected

- **Instacart Developer Platform** — clean API, but marked-up prices + fees. Out per
  household policy: first-party prices only.

## Troubleshooting (learned live)

- **Apps created in Kroger's NEW portal authenticate against `https://api-ce.kroger.com/v1`**,
  not the classic `api.kroger.com` (which returns 401 "invalid credentials"). Set
  `KROGER_API_BASE="https://api-ce.kroger.com/v1"` in `.env`.
- **The Certification environment has no live product catalog.** Token + Locations work on
  `api-ce`, but `/products` returns 504 "The upstream server is timing out" regardless of
  scopes. Certification is for OAuth/integration testing only — register a **Production**
  environment app (separate credentials) for real per-store prices, and set
  `KROGER_API_BASE="https://api.kroger.com/v1"` (the default).

## Fry's digital coupons (approval-gated clipping)

Kroger's web properties reject non-browser TLS outright (Akamai) — verified: connections
drop in ~0.14s even for the homepage. So coupon work runs a real Chromium **on the host**
via Playwright (the same approach as every working community clipper):

```bash
pnpm --filter @meals/api exec playwright install chromium     # once
pnpm --filter @meals/api exec tsx src/scripts/kroger-coupons.ts --login   # once: sign in yourself
pnpm --filter @meals/api exec tsx src/scripts/kroger-coupons.ts           # fetch -> proposals
#   -> approve/dismiss in the app (Shop tab -> "Fry's digital coupons")
pnpm --filter @meals/api exec tsx src/scripts/kroger-coupons.ts --clip-approved
```

- Coupons match to your items UPC-first (against synced Fry's products), fuzzy vs list names
  second. "Approve all matched" bulk-stages the useful ones — mindful of Kroger's ~150
  clipped-coupon account cap, nothing clips without approval.
- After clipping, matched coupons write coupon-adjusted PriceObservations
  (dealType=digital-coupon, valid until coupon expiry) so the optimizer sees true costs.
- The internal endpoints are unofficial and move occasionally; the script tries known
  variants and tells you how to add a new one if they all miss. Session state lives in
  storage/kroger-web-state.json (gitignored).
