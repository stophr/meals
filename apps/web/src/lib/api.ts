import { createClient } from '@meals/shared';

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001';

// Recover from an expired Cloudflare Access session.
//
// The app is a PWA behind Cloudflare Access. Once the Access session expires, the service
// worker still serves the cached shell (so the page opens), but every same-origin /api fetch
// is 302'd to the cross-origin cloudflareaccess.com login — which fetch() can't follow, so
// Safari rejects it as "Load failed". A *document* navigation CAN follow that redirect, so we
// bounce the whole page to `/?reauth=1`. That path is excluded from the SW navigation cache
// (vite.config.ts navigateFallbackDenylist), so it actually hits Cloudflare: an expired
// session lands on the Access login, and once re-authenticated Cloudflare returns to the app.
//
// Guarded so it only runs on the public host (never LAN/localhost dev) and at most once every
// 15s, so a transient blip or a genuinely-offline device can't spin in a reload loop.
function reauthThroughAccess() {
  if (typeof window === 'undefined') return;
  const host = window.location.hostname;
  // Public hostname only — skip localhost and bare LAN IPs (dev has no Access in front).
  const isLanOrLocal = host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (isLanOrLocal) return;

  // The 15s timestamp is the loop guard: after a bounce, a still-failing app can't re-bounce
  // until the window passes (by which point a real re-auth has resolved it, or the device is
  // genuinely offline and shouldn't keep reloading).
  const KEY = 'cf-reauth-at';
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < 15_000) return;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* sessionStorage may be unavailable (private mode) — proceed without the guard */
  }
  window.location.assign('/?reauth=1');
}

export const api = createClient({ baseUrl, onNetworkError: reauthThroughAccess });
