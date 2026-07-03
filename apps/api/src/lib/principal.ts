import type { FastifyRequest } from 'fastify';
import { prisma } from '@meals/db';
import { getHousehold } from './household.js';
import { isRole, type Principal, type Role } from './permissions.js';

// Resolve the caller from their session token (Authorization: Bearer <sessionToken>, minted by
// the magic-link flow and cached on the device for ~3 months). STUB PHASE: until email is
// wired up, an unauthenticated request falls back to the default org's chef so the app keeps
// working single-tenant. Once real sessions exist, remove the fallback to require sign-in.
export async function getPrincipal(req: FastifyRequest): Promise<Principal> {
  const auth = req.headers['authorization'];
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-pantrezy-session'] as string | undefined);

  if (token) {
    const session = await prisma.session.findUnique({ where: { token }, include: { user: true } });
    if (session && session.expiresAt > new Date()) {
      await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
      const u = session.user;
      return {
        userId: u.id,
        householdId: u.householdId,
        email: u.email,
        role: (isRole(u.role) ? u.role : 'base') as Role,
        isAppAdmin: u.isAppAdmin,
      };
    }
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
