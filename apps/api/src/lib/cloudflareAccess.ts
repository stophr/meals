import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../env.js';

// Verify the JWT that Cloudflare Access injects (Cf-Access-Jwt-Assertion) and return the
// authenticated email. RS256, verified against the team's JWKS, with issuer + audience (the
// Access application's AUD tag) checked. Returns null if Access isn't configured, no token is
// present, or verification fails.

function teamUrl(): string {
  const d = env.CF_ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `https://${d}`;
}

export function accessConfigured(): boolean {
  return !!(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD);
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export async function emailFromAccessJwt(token: string): Promise<string | null> {
  if (!accessConfigured()) return null;
  if (!jwks) jwks = createRemoteJWKSet(new URL(`${teamUrl()}/cdn-cgi/access/certs`));
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: teamUrl(),
      audience: env.CF_ACCESS_AUD,
    });
    const email = payload.email as string | undefined;
    return email ? email.toLowerCase().trim() : null;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[access] JWT verification failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
