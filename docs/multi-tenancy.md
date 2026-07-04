# Multi-tenancy, roles, passwordless auth, substitutions

Status: **foundation stubbed**. The data model and route scaffolding are in place; the only
missing piece is **email delivery**, which is a logged no-op until the `pantrezy.com` domain
and a mail provider are configured. The app runs single-tenant today via an unauthenticated
fallback, so nothing is blocked by the stub.

## Tenancy model

- **`Household` IS the org/tenant.** It scopes inventory, providers, prices, meal plans,
  shopping lists, substitutions, and users (everything keys off `householdId`). Surfaced as
  "Org" in the UI. Fields added: `slug` (unique).
- **Recipes are a global directory.** `Recipe.isShared` (default `true`) — a shared recipe is
  visible to every org; `householdId` is the owner. When a tenant adds a recipe it's shared by
  default. (Visibility filtering to `isShared OR owner` is a one-line query change to make when
  the second org lands — today there's one org so all recipes show.)

### Deferred (safe while single-tenant, do before onboarding org #2)

1. **Global canonical items.** `CanonicalItem` is currently per-household. A *shared* recipe's
   ingredient links point at the owner's canonical items, which another org can't resolve.
   Promote canonical items (the store-agnostic ingredient dictionary) to global, keeping
   inventory/prices/aliases/substitutions per-org. This is the biggest deferred migration.
2. **Per-org recipe state.** `isFavorite`, `timesCooked`, `lastCookedAt`, and the cached
   `estCost*` live on `Recipe` (fine for one org). Move them to a per-`(org, recipe)` join so
   each tenant has its own favorites/cook counts and price-based cost (prices are per-org).

## Roles

| role | capabilities |
|------|--------------|
| `base` | view the upcoming meal lineup (read-only) |
| `sous_chef` | everything except inviting/removing users |
| `chef` | everything, including inviting/removing users |
| app admin (`isAppAdmin` flag) | invite new orgs to the app |

- The **first user to join an org becomes `chef`**. `apps/api/src/lib/permissions.ts` holds the
  capability matrix; `principal.ts` resolves the caller.
- Enforcement lives on the management endpoints (org invite = app admin; user invite/remove =
  chef). Broader per-route enforcement (e.g. blocking `base` from edits) wraps in when auth is
  required for every request — today the stub fallback treats the caller as the default org's
  admin.

## Auth: Cloudflare Access (current)

Authentication is delegated to **Cloudflare Access** (Zero Trust) in front of the tunnel. The
user does email-OTP with Cloudflare; Access injects a signed `Cf-Access-Jwt-Assertion` header.
`apps/api/src/lib/cloudflareAccess.ts` verifies it (jose, RS256, JWKS from the team domain,
issuer + AUD checked) and `principal.ts` resolves the caller by that email.

- **No auto-provisioning.** An Access-authenticated email that is not a `User` is a *guest* —
  the API returns 403 for members-only routes and `/auth/me` reports `provisioned:false`; the
  web shows a "not a member" gate. Members must be created explicitly (below).
- **No email invites.** Cloudflare handles the login email, so members are created **directly**:
  an app admin creates orgs + users in any org; a chef creates/manages users in their own org
  (Settings → 🏛️ Organization). Endpoints: `GET/POST /orgs` (admin), `GET/POST /users`,
  `PATCH /users/:id/role`, `DELETE /users/:id`.
- **Config:** `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` (Access app's Audience tag). When unset
  (local dev with no CF header), requests fall back to the default org's admin so on-box work
  continues. **Keep the Cloudflare Access policy's email allowlist in sync with the app's user
  list** (or automate later via the Cloudflare API from `POST /users`).

## Native-app session path (magic links)

No passwords. A short-lived **magic link** is emailed; following it mints a **`Session`** cached
on the device for **~90 days** (`SESSION_DAYS`). Sessions are sent back as
`Authorization: Bearer <sessionToken>`.

Flow (all working except the email send):

1. `POST /auth/request-link {email}` → creates a `MagicLink` (20-min TTL) and "emails" it.
2. `POST /auth/accept {token, device?}` → validates the link, creates the user on invite
   acceptance (first user → chef), mints a `Session`, returns the session token.
3. `GET /auth/me` → the current principal + org. `POST /auth/logout` → drop the session.

Org / user management:

- `POST /orgs {name, chefEmail}` — **app admin** creates an org and invites its first chef.
- `POST /users/invite {email, role}` — **chef** invites into their org.
- `DELETE /users/:id` — **chef** removes a member (not themselves).

### Wiring email (the one TODO)

Everything routes through `sendMagicLink()` in `apps/api/src/lib/email.ts`, currently a
`console.log` no-op that returns the URL in non-prod. When `pantrezy.com` is live:

1. Add a transport (Resend / Postmark / SES) inside `sendMagicLink` — no caller changes.
2. Set `WEB_BASE_URL=https://pantrezy.com` and the provider key in the API env.
3. Build `/auth/accept` as a real page (or a redirect) so the emailed link lands in the app.

The current fallback in `principal.ts` (treat unauthenticated as the default org's admin) should
be **removed** once real sign-in is required, so unauthenticated requests are rejected.

## Ingredient substitutions (fully working)

Tenant-scoped ingredient swaps — "always use Avocado Oil for Olive Oil."

- **`IngredientSubstitution`** (`from`→`to` canonical item, org-scoped). `recipeId = null` is an
  **org-global rule** (remembered until reverted/changed); `recipeId` set scopes it to one
  recipe and overrides the global rule there.
- Applied — same amount, swapped item + its density/stock facts — in recipe display, pantry
  coverage, costing, and shopping-list building (`apps/api/src/lib/substitutions.ts`).
- UI: on a recipe, tap 🔄 next to an ingredient to substitute (org-wide) or ↩︎ to revert.
  Settings → 🔄 Ingredient substitutions lists and reverts all rules.
- API: `GET/POST/DELETE /substitutions`.
- Cart level: a per-item swap on a shopping list is the natural extension (endpoint shape
  mirrors the recipe path; not yet surfaced in the cart UI).
