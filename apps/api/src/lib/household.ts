import type { FastifyRequest } from 'fastify';
import { prisma } from '@meals/db';
import type { Household } from '@meals/db';
import { resolvePrincipal } from './principal.js';
import { can } from './permissions.js';

// Resolve the tenant (org = household) a request operates on — from the AUTHENTICATED user, so
// each org sees only its own pantry, providers, prices, shopping lists, and Fry's connection.
export async function getHousehold(req: FastifyRequest): Promise<Household> {
  const { principal } = await resolvePrincipal(req);
  if (!principal) {
    const e = new Error('You are signed in but not a member of an org.') as Error & { statusCode?: number };
    e.statusCode = 403;
    throw e;
  }
  return prisma.household.findUniqueOrThrow({ where: { id: principal.householdId } });
}

/** getHousehold for mutations: additionally require a role with the edit capability. */
export async function requireEditor(req: FastifyRequest): Promise<Household> {
  const { principal } = await resolvePrincipal(req);
  if (!principal) {
    const e = new Error('You are signed in but not a member of an org.') as Error & { statusCode?: number };
    e.statusCode = 403;
    throw e;
  }
  if (!can(principal, 'edit')) {
    const e = new Error('Your role is view-only.') as Error & { statusCode?: number };
    e.statusCode = 403;
    throw e;
  }
  return prisma.household.findUniqueOrThrow({ where: { id: principal.householdId } });
}

/** The primary (oldest) household — for CLI scripts / non-request contexts only. */
export async function primaryHousehold(): Promise<Household> {
  return prisma.household.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
}
