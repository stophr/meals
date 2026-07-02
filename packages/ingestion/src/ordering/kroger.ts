// Kroger Public API client (developer.kroger.com) — covers all Kroger banners including
// Fry's. Three surfaces used here:
//   Locations: find stores (filter.chain=FRYS, zip radius)
//   Products:  per-store catalog with REAL prices incl. promo (needs filter.locationId)
//   Cart:      add items to the signed-in user's actual cart (OAuth authorization-code)
// Client-credentials tokens cover locations+products; the cart needs a user token.

const API = 'https://api.kroger.com/v1';

export interface KrogerConfig {
  clientId: string;
  clientSecret: string;
  redirectUri?: string; // required only for the user-auth (cart) flow
}

export interface KrogerLocation {
  locationId: string;
  chain: string;
  name: string;
  address: string;
  lat?: number;
  lng?: number;
}

export interface KrogerProduct {
  productId: string;
  upc: string;
  description: string;
  brand?: string;
  size?: string;
  regular?: number;
  promo?: number; // 0/undefined when not on promo
  aisle?: string;
}

export interface KrogerTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

function basicAuth(cfg: KrogerConfig): string {
  return `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`;
}

async function tokenRequest(cfg: KrogerConfig, body: URLSearchParams): Promise<KrogerTokens> {
  const res = await fetch(`${API}/connect/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: basicAuth(cfg),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Kroger token HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const data = (await res.json()) as TokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + (data.expires_in - 60) * 1000),
  };
}

/** App-level token for locations/products (no user involved). */
export async function clientToken(cfg: KrogerConfig): Promise<KrogerTokens> {
  return tokenRequest(
    cfg,
    new URLSearchParams({ grant_type: 'client_credentials', scope: 'product.compact' }),
  );
}

/** URL to send the user to for cart authorization (Fry's/Kroger login page). */
export function authorizeUrl(cfg: KrogerConfig, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri ?? '',
    scope: 'cart.basic:write profile.compact',
    state,
  });
  return `${API}/connect/oauth2/authorize?${params}`;
}

export async function exchangeCode(cfg: KrogerConfig, code: string): Promise<KrogerTokens> {
  return tokenRequest(
    cfg,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: cfg.redirectUri ?? '',
    }),
  );
}

export async function refreshUserToken(cfg: KrogerConfig, refreshToken: string): Promise<KrogerTokens> {
  return tokenRequest(
    cfg,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  );
}

async function apiGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Kroger HTTP ${res.status} on ${path}: ${await res.text().catch(() => '')}`);
  return (await res.json()) as T;
}

interface RawLocation {
  locationId: string;
  chain: string;
  name: string;
  address?: { addressLine1?: string; city?: string; state?: string; zipCode?: string };
  geolocation?: { latitude?: number; longitude?: number };
}

export async function searchLocations(
  token: string,
  opts: { zip: string; chain?: string; limit?: number },
): Promise<KrogerLocation[]> {
  const params = new URLSearchParams({
    'filter.zipCode.near': opts.zip,
    'filter.limit': String(opts.limit ?? 10),
  });
  if (opts.chain) params.set('filter.chain', opts.chain);
  const data = await apiGet<{ data: RawLocation[] }>(token, `/locations?${params}`);
  return (data.data ?? []).map((l) => ({
    locationId: l.locationId,
    chain: l.chain,
    name: l.name,
    address: [l.address?.addressLine1, l.address?.city, l.address?.state, l.address?.zipCode]
      .filter(Boolean)
      .join(', '),
    lat: l.geolocation?.latitude,
    lng: l.geolocation?.longitude,
  }));
}

interface RawProduct {
  productId: string;
  upc: string;
  description: string;
  brand?: string;
  items?: {
    size?: string;
    price?: { regular?: number; promo?: number };
  }[];
  aisleLocations?: { description?: string }[];
}

/** Pure mapper (exported for tests). */
export function mapProduct(p: RawProduct): KrogerProduct {
  const item = p.items?.[0];
  const promo = item?.price?.promo;
  return {
    productId: p.productId,
    upc: p.upc,
    description: p.description,
    brand: p.brand,
    size: item?.size,
    regular: item?.price?.regular,
    promo: promo && promo > 0 ? promo : undefined,
    aisle: p.aisleLocations?.[0]?.description,
  };
}

export async function searchProducts(
  token: string,
  opts: { term: string; locationId: string; limit?: number },
): Promise<KrogerProduct[]> {
  const params = new URLSearchParams({
    'filter.term': opts.term.slice(0, 128),
    'filter.locationId': opts.locationId,
    'filter.limit': String(opts.limit ?? 8),
  });
  const data = await apiGet<{ data: RawProduct[] }>(token, `/products?${params}`);
  return (data.data ?? []).map(mapProduct);
}

/** Add items to the signed-in user's real Kroger/Fry's cart. */
export async function addToCart(
  userToken: string,
  items: { upc: string; quantity: number }[],
): Promise<void> {
  const res = await fetch(`${API}/cart/add`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${userToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      items: items.map((i) => ({ upc: i.upc, quantity: i.quantity, modality: 'PICKUP' })),
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Kroger cart HTTP ${res.status}: ${await res.text().catch(() => '')}`);
}
