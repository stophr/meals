import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@meals/db';
import { env } from '../env.js';
import { sendMagicLink } from '../lib/email.js';
import { getPrincipal } from '../lib/principal.js';
import { can, isRole } from '../lib/permissions.js';

// Passwordless auth + org/user management. STUB PHASE: email delivery is a no-op that logs the
// link (and returns it in dev). Wiring a real mail transport in lib/email.ts is the only thing
// left once pantrezy.com is live. Role enforcement is real; the unauthenticated fallback (see
// principal.ts) keeps the app usable single-tenant until sign-in is required.

const token = () => randomBytes(24).toString('base64url');
const linkUrl = (t: string) => `${env.WEB_BASE_URL}/auth/accept?token=${t}`;

async function inviteLink(opts: {
  email: string;
  householdId?: string;
  intendedRole?: string;
  purpose: string;
}) {
  const t = token();
  await prisma.magicLink.create({
    data: {
      email: opts.email.toLowerCase().trim(),
      householdId: opts.householdId,
      intendedRole: opts.intendedRole,
      token: t,
      expiresAt: new Date(Date.now() + env.MAGIC_LINK_MINUTES * 60_000),
    },
  });
  return sendMagicLink(opts.email, linkUrl(t), opts.purpose);
}

export async function authRoutes(app: FastifyInstance) {
  // --- sign in: email me a link ---
  app.post('/auth/request-link', async (req) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    // Don't reveal whether the address exists; only mint a link when it does.
    if (!user) return { sent: true };
    const r = await inviteLink({ email, purpose: 'sign-in' });
    return { sent: true, devUrl: r.devUrl };
  });

  // --- accept a link: mint a device session (~3 months) ---
  app.post('/auth/accept', async (req, reply) => {
    const { token: t, device } = z
      .object({ token: z.string().min(1), device: z.string().optional() })
      .parse(req.body);
    const link = await prisma.magicLink.findUnique({ where: { token: t } });
    if (!link || link.consumedAt || link.expiresAt < new Date()) {
      reply.code(401);
      return { message: 'That link is invalid or expired. Request a new one.' };
    }

    let user = await prisma.user.findUnique({ where: { email: link.email } });
    if (!user) {
      // Invite acceptance: create the user. First user in a fresh org becomes chef.
      const householdId = link.householdId!;
      const existing = await prisma.user.count({ where: { householdId } });
      user = await prisma.user.create({
        data: {
          householdId,
          email: link.email,
          role: existing === 0 ? 'chef' : link.intendedRole && isRole(link.intendedRole) ? link.intendedRole : 'base',
        },
      });
    }

    const session = await prisma.session.create({
      data: {
        userId: user.id,
        token: token(),
        device,
        expiresAt: new Date(Date.now() + env.SESSION_DAYS * 86_400_000),
      },
    });
    await prisma.magicLink.update({ where: { id: link.id }, data: { consumedAt: new Date() } });
    return {
      session: session.token,
      expiresAt: session.expiresAt,
      user: { email: user.email, role: user.role, isAppAdmin: user.isAppAdmin, householdId: user.householdId },
    };
  });

  app.get('/auth/me', async (req) => {
    const p = await getPrincipal(req);
    const org = await prisma.household.findUnique({ where: { id: p.householdId }, select: { name: true, slug: true } });
    return { ...p, org };
  });

  app.post('/auth/logout', async (req: FastifyRequest, reply) => {
    const auth = req.headers['authorization'];
    const t = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (t) await prisma.session.deleteMany({ where: { token: t } });
    reply.code(204);
  });

  // --- app admin: invite a new org (creates it + invites its first chef) ---
  app.post('/orgs', async (req, reply) => {
    const p = await getPrincipal(req);
    if (!p.isAppAdmin) {
      reply.code(403);
      return { message: 'Only the app admin can invite orgs.' };
    }
    const { name, chefEmail } = z
      .object({ name: z.string().min(1), chefEmail: z.string().email() })
      .parse(req.body);
    const org = await prisma.household.create({ data: { name } });
    const r = await inviteLink({ email: chefEmail, householdId: org.id, intendedRole: 'chef', purpose: 'org invite' });
    reply.code(201);
    return { org: { id: org.id, name: org.name }, invited: chefEmail, devUrl: r.devUrl };
  });

  // --- org members ---
  app.get('/users', async (req) => {
    const p = await getPrincipal(req);
    return prisma.user.findMany({
      where: { householdId: p.householdId },
      select: { id: true, email: true, displayName: true, role: true, isAppAdmin: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  });

  // chef only: invite a user into the caller's org
  app.post('/users/invite', async (req, reply) => {
    const p = await getPrincipal(req);
    if (!can(p, 'manageUsers')) {
      reply.code(403);
      return { message: 'Only a chef can invite users.' };
    }
    const { email, role } = z
      .object({ email: z.string().email(), role: z.enum(['base', 'sous_chef', 'chef']).default('base') })
      .parse(req.body);
    const r = await inviteLink({ email, householdId: p.householdId, intendedRole: role, purpose: 'user invite' });
    reply.code(201);
    return { invited: email, role, devUrl: r.devUrl };
  });

  // chef only: remove a user (not yourself)
  app.delete('/users/:id', async (req, reply) => {
    const p = await getPrincipal(req);
    if (!can(p, 'manageUsers')) {
      reply.code(403);
      return { message: 'Only a chef can remove users.' };
    }
    const { id } = req.params as { id: string };
    if (id === p.userId) {
      reply.code(422);
      return { message: "You can't remove yourself." };
    }
    await prisma.user.deleteMany({ where: { id, householdId: p.householdId } });
    reply.code(204);
  });
}
