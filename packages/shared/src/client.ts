// Thin typed fetch client shared by the web PWA (and later the React Native app).
// It intentionally stays transport-only: callers pass paths and bodies, get parsed JSON.

export interface HealthResponse {
  status: 'ok';
  db: 'up' | 'down';
  time: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ClientOptions {
  baseUrl: string;
  // Injected later for auth (Phase 3). No-op today.
  getAuthHeader?: () => Record<string, string> | undefined;
  fetchImpl?: typeof fetch;
  // Called when fetch REJECTS (network layer) rather than returning a response — e.g. behind
  // Cloudflare Access, an expired session 302s a same-origin /api XHR to a cross-origin login
  // that fetch can't follow, surfacing as "Load failed". Lets the host app re-authenticate.
  onNetworkError?: () => void;
}

export function createClient(opts: ClientOptions) {
  const base = opts.baseUrl.replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? fetch;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { ...opts.getAuthHeader?.() };
    if (body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // Network-layer failure (offline, DNS, or a cross-origin Access-login redirect fetch
      // can't follow). Give the host a chance to re-authenticate, then surface a clean error.
      opts.onNetworkError?.();
      throw new ApiError(0, 'Could not reach the server', err);
    }

    const text = await res.text();
    const parsed = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const msg =
        parsed && typeof parsed === 'object' && 'message' in parsed
          ? String((parsed as { message: unknown }).message)
          : res.statusText;
      throw new ApiError(res.status, msg, parsed);
    }
    return parsed as T;
  }

  return {
    request,
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
    patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
    del: <T>(path: string) => request<T>('DELETE', path),
    health: () => request<HealthResponse>('GET', '/health'),
  };
}

export type ApiClient = ReturnType<typeof createClient>;
