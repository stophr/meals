import type { FastifyRequest } from 'fastify';
import { prisma } from '@meals/db';
import type { User } from '@meals/db';
import { getHousehold } from './household.js';
import { accessConfigured, emailFromAccessJwt } from './cloudflareAccess.js';
import { isRole, type Principal, type Role } from './permissions.js';

function principalOf(u: User): Principal {
  return {
    userId: u.id,
    householdId: u.householdId,
    email: u.email,
    role: (isRole(u.role) ? u.role : 'base') as Role,
    isAppAdmin: u.isAppAdmin,
  };
}

class Unauthorized extends Error {
  statusCode = 401;
}

// Resolve the caller, in priority order:
//   1. A device session (Authorization: Bearer <sessionToken>) — for a future native app.
//   2. Cloudflare Access — a verified Cf-Access-Jwt-Assertion logs the user in as that email
//      (invited emails Access lets through are auto-provisioned as 'base'). A present-but-
//      invalid token is a hard 401 so misconfiguration surfaces instead of silently admin-ing.
//   3. No auth headers at all (LAN / localhost, direct — not through Cloudflare): fall back to
//      the default org's admin so local dev keeps working.
export async function getPrincipal(req: FastifyRequest): Promise<Principal> {
  const auth = req.headers['authorization'];
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-pantrezy-session'] as string | undefined);

  if (token) {
    const session = await prisma.session.findUnique({ where: { token }, include: { user: true } });
    if (session && session.expiresAt > new Date()) {
      await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
      return principalOf(session.user);
    }
  }

  // Cloudflare Access (present only on requests that came through the tunnel).
  const cfToken = req.headers['cf-access-jwt-assertion'] as string | undefined;
  if (accessConfigured() && cfToken) {
    const email = await emailFromAccessJwt(cfToken);
    if (!email) throw new Unauthorized('Cloudflare Access token failed verification');
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return principalOf(existing);
    // Access already gated this email (only invited addresses get through) — provision as base.
    const household = await getHousehold();
    const created = await prisma.user.create({ data: { householdId: household.id, email, role: 'base' } });
    return principalOf(created);
  }

  // Fallback (stub): the default org's app-admin (preferred), else its oldest chef.
  const household = await getHousehold();
  const chef =
    (await prisma.user.findFirst({
      where: { householdId: household.id },
      orderBy: [{ isAppAdmin: 'desc' }, { createdAt: 'asc' }],
    })) ??
    (await prisma.user.create({
      data: { householdId: household.id, email: `owner@${household.slug ?? 'default-org'}.local`, role: 'chef', isAppAdmin: true },
    }));
  return {
    userId: chef.id,
    householdId: chef.householdId,
    email: chef.email,
    role: (isRole(chef.role) ? chef.role : 'chef') as Role,
    isAppAdmin: chef.isAppAdmin,
  };
}
