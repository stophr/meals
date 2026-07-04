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
class NotAMember extends Error {
  statusCode = 403;
  constructor(public authEmail: string) {
    super('You are signed in but not a member of an org yet. Ask an admin to add you.');
  }
}

/**
 * Resolve the caller. Returns a full principal for a provisioned member, or `{ guestEmail }`
 * for someone Cloudflare authenticated who is NOT yet a member (they must be added by an admin
 * or chef — we do NOT auto-provision). Order: device session → Cloudflare Access → LAN fallback.
 */
export async function resolvePrincipal(
  req: FastifyRequest,
): Promise<{ principal?: Principal; guestEmail?: string }> {
  const auth = req.headers['authorization'];
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-pantrezy-session'] as string | undefined);

  if (token) {
    const session = await prisma.session.findUnique({ where: { token }, include: { user: true } });
    if (session && session.expiresAt > new Date()) {
      await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
      return { principal: principalOf(session.user) };
    }
  }

  const cfToken = req.headers['cf-access-jwt-assertion'] as string | undefined;
  if (accessConfigured() && cfToken) {
    const email = await emailFromAccessJwt(cfToken);
    if (!email) throw new Unauthorized('Cloudflare Access token failed verification');
    const user = await prisma.user.findUnique({ where: { email } });
    return user ? { principal: principalOf(user) } : { guestEmail: email };
  }

  // Fallback (no CF header — LAN/localhost, not through the tunnel): the default org's admin.
  const household = await getHousehold();
  const chef =
    (await prisma.user.findFirst({
      where: { householdId: household.id },
      orderBy: [{ isAppAdmin: 'desc' }, { createdAt: 'asc' }],
    })) ??
    (await prisma.user.create({
      data: { householdId: household.id, email: `owner@${household.slug ?? 'default-org'}.local`, role: 'chef', isAppAdmin: true },
    }));
  return { principal: principalOf(chef) };
}

/** Require a provisioned member; 403 for an authenticated non-member. */
export async function getPrincipal(req: FastifyRequest): Promise<Principal> {
  const { principal, guestEmail } = await resolvePrincipal(req);
  if (principal) return principal;
  throw new NotAMember(guestEmail!);
}
