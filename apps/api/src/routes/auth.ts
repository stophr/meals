import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@meals/db';
import { env } from '../env.js';
import { sendMagicLink } from '../lib/email.js';
import { getPrincipal, resolvePrincipal } from '../lib/principal.js';
import { can } from '../lib/permissions.js';

// Auth + org/user management. Authentication is handled by Cloudflare Access (email OTP) — the
// app just needs each user to EXIST with a role/org. So members are created DIRECTLY by an app
// admin (any org) or a chef (their own org); no email invites. The /auth/request-link + accept
// endpoints remain for a future native-app session path.

const roleEnum = z.enum(['base', 'sous_chef', 'chef']);
const token = () => randomBytes(24).toString('base64url');

export async function authRoutes(app: FastifyInstance) {
  // --- who am I (tolerant: reports non-members instead of erroring) ---
  app.get('/auth/me', async (req) => {
    const { principal, guestEmail } = await resolvePrincipal(req);
    if (!principal) return { authenticated: true, provisioned: false, email: guestEmail };
    const org = await prisma.household.findUnique({
      where: { id: principal.householdId },
      select: { id: true, name: true, slug: true },
    });
    return { ...principal, provisioned: true, org };
  });

  // --- native-app session path (Cloudflare Access covers the web/PWA) ---
  app.post('/auth/request-link', async (req) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!user) return { sent: true }; // don't reveal existence
    const t = token();
    await prisma.magicLink.create({
      data: { email: user.email, token: t, expiresAt: new Date(Date.now() + env.MAGIC_LINK_MINUTES * 60_000) },
    });
    const r = await sendMagicLink(user.email, `${env.WEB_BASE_URL}/auth/accept?token=${t}`, 'sign-in');
    return { sent: true, devUrl: r.devUrl };
  });

  app.post('/auth/accept', async (req, reply) => {
    const { token: t, device } = z.object({ token: z.string().min(1), device: z.string().optional() }).parse(req.body);
    const link = await prisma.magicLink.findUnique({ where: { token: t } });
    if (!link || link.consumedAt || link.expiresAt < new Date()) {
      reply.code(401);
      return { message: 'That link is invalid or expired.' };
    }
    const user = await prisma.user.findUnique({ where: { email: link.email } });
    if (!user) {
      reply.code(403);
      return { message: 'No account for that email — ask an admin to add you.' };
    }
    const session = await prisma.session.create({
      data: { userId: user.id, token: token(), device, expiresAt: new Date(Date.now() + env.SESSION_DAYS * 86_400_000) },
    });
    await prisma.magicLink.update({ where: { id: link.id }, data: { consumedAt: new Date() } });
    return { session: session.token, expiresAt: session.expiresAt };
  });

  app.post('/auth/logout', async (req: FastifyRequest, reply) => {
    const auth = req.headers['authorization'];
    const t = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (t) await prisma.session.deleteMany({ where: { token: t } });
    reply.code(204);
  });

  // ============================ Org management (app admin) ============================

  // List every org with its members.
  app.get('/orgs', async (req, reply) => {
    const p = await getPrincipal(req);
    if (!p.isAppAdmin) {
      reply.code(403);
      return { message: 'App admin only.' };
    }
    return prisma.household.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        users: {
          select: { id: true, email: true, role: true, isAppAdmin: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
        _count: { select: { recipes: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  });

  // Create an org (and optionally its first chef, directly — no email).
  app.post('/orgs', async (req, reply) => {
    const p = await getPrincipal(req);
    if (!p.isAppAdmin) {
      reply.code(403);
      return { message: 'App admin only.' };
    }
    const { name, chefEmail } = z
      .object({ name: z.string().min(1), chefEmail: z.string().email().optional() })
      .parse(req.body);
    const org = await prisma.household.create({ data: { name } });
    if (chefEmail) {
      await prisma.user.create({ data: { householdId: org.id, email: chefEmail.toLowerCase().trim(), role: 'chef' } });
    }
    reply.code(201);
    return { id: org.id, name: org.name };
  });

  // ============================ User management (admin any org, chef own org) ==========

  app.get('/users', async (req) => {
    const p = await getPrincipal(req);
    const q = req.query as { householdId?: string };
    const householdId = p.isAppAdmin && q.householdId ? q.householdId : p.householdId;
    return prisma.user.findMany({
      where: { householdId },
      select: { id: true, email: true, displayName: true, role: true, isAppAdmin: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  });

  // Add a member directly. Admin → any org (householdId); chef → own org only.
  app.post('/users', async (req, reply) => {
    const p = await getPrincipal(req);
    const { email, role, householdId } = z
      .object({ email: z.string().email(), role: roleEnum.default('base'), householdId: z.string().optional() })
      .parse(req.body);
    const targetOrg = p.isAppAdmin && householdId ? householdId : p.householdId;
    if (!p.isAppAdmin && !can(p, 'manageUsers')) {
      reply.code(403);
      return { message: 'Only a chef or app admin can add users.' };
    }
    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (existing) {
      reply.code(409);
      return { message: `${email} already has an account.` };
    }
    reply.code(201);
    return prisma.user.create({
      data: { householdId: targetOrg, email: email.toLowerCase().trim(), role },
      select: { id: true, email: true, role: true },
    });
  });

  app.patch('/users/:id/role', async (req, reply) => {
    const p = await getPrincipal(req);
    const { id } = req.params as { id: string };
    const { role } = z.object({ role: roleEnum }).parse(req.body);
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      reply.code(404);
      return { message: 'No such user.' };
    }
    const allowed = p.isAppAdmin || (can(p, 'manageUsers') && target.householdId === p.householdId);
    if (!allowed) {
      reply.code(403);
      return { message: 'Not allowed to change this user.' };
    }
    return prisma.user.update({ where: { id }, data: { role }, select: { id: true, email: true, role: true } });
  });

  app.delete('/users/:id', async (req, reply) => {
    const p = await getPrincipal(req);
    const { id } = req.params as { id: string };
    if (id === p.userId) {
      reply.code(422);
      return { message: "You can't remove yourself." };
    }
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      reply.code(204);
      return;
    }
    const allowed = p.isAppAdmin || (can(p, 'manageUsers') && target.householdId === p.householdId);
    if (!allowed) {
      reply.code(403);
      return { message: 'Not allowed to remove this user.' };
    }
    await prisma.user.delete({ where: { id } });
    reply.code(204);
  });
}
