import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma } from '@meals/db';
import {
  authorizeUrl,
  exchangeCode,
  searchLocations,
  addToCart,
  walmartCartLink,
  safewaySearchLinks,
} from '@meals/ingestion';
import { z } from 'zod';
import {
  costcoImportSchema,
  parsePricesSchema,
  parsedPriceSchema,
  parsePriceOneSchema,
  parsedPriceOneSchema,
} from '@meals/shared';
import { chatJson } from '@meals/ingestion';
import { getHousehold } from '../lib/household.js';
import { computeItemOptions } from '../lib/shoppingOptions.js';
import { krogerConfig, krogerLocationId, getAppToken, getUserToken, syncPrices } from '../lib/kroger.js';
import { recordCostcoPrices } from '../lib/costcoPrices.js';
import { env } from '../env.js';

// Short-lived state values for the OAuth redirect round-trip (CSRF protection).
const pendingStates = new Map<string, number>();

export async function integrationRoutes(app: FastifyInstance) {
  // ---- Kroger / Fry's ----
  app.get('/integrations/kroger/status', async (req) => {
    const cfg = krogerConfig();
    const household = await getHousehold(req);
    const token = await prisma.integrationToken.findUnique({
      where: { householdId_kind: { householdId: household.id, kind: 'kroger' } },
    });
    const linked = await prisma.provider.findMany({ where: { householdId: household.id } });
    return {
      configured: !!cfg,
      cartAuthorized: !!token,
      linkedProviders: linked
        .filter((p) => krogerLocationId(p))
        .map((p) => ({ id: p.id, name: p.name, locationId: krogerLocationId(p) })),
    };
  });

  // Find nearby Kroger-banner stores (chain=FRYS for Fry's; omit for all banners).
  app.get('/integrations/kroger/locations', async (req, reply) => {
    const cfg = krogerConfig();
    if (!cfg) {
      reply.code(503);
      return { message: 'Kroger not configured — set KROGER_CLIENT_ID / KROGER_CLIENT_SECRET' };
    }
    const { zip, chain } = req.query as { zip?: string; chain?: string };
    if (!zip) {
      reply.code(400);
      return { message: 'zip required' };
    }
    const token = await getAppToken(cfg);
    return searchLocations(cfg, token, { zip, chain: chain ?? 'FRYS' });
  });

  // Attach a Kroger location to one of our providers.
  app.post('/providers/:id/link-kroger', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { locationId } = req.body as { locationId?: string };
    if (!locationId) {
      reply.code(400);
      return { message: 'locationId required' };
    }
    return prisma.provider.update({
      where: { id },
      data: { integration: { type: 'kroger', locationId } },
    });
  });

  // OAuth: send the user to the Fry's/Kroger login to authorize cart pushes.
  app.get('/integrations/kroger/authorize', async (_req, reply) => {
    const cfg = krogerConfig();
    if (!cfg?.redirectUri) {
      reply.code(503);
      return { message: 'Kroger not configured' };
    }
    const state = randomUUID();
    pendingStates.set(state, Date.now());
    // Prune stale states (10 min window).
    for (const [s, t] of pendingStates) if (Date.now() - t > 600_000) pendingStates.delete(s);
    reply.redirect(authorizeUrl(cfg, state));
  });

  app.get('/integrations/kroger/callback', async (req, reply) => {
    const cfg = krogerConfig();
    const { code, state } = req.query as { code?: string; state?: string };
    if (!cfg || !code || !state || !pendingStates.has(state)) {
      reply.code(400);
      return { message: 'Invalid OAuth callback' };
    }
    pendingStates.delete(state);
    const tokens = await exchangeCode(cfg, code);
    const household = await getHousehold(req);
    await prisma.integrationToken.upsert({
      where: { householdId_kind: { householdId: household.id, kind: 'kroger' } },
      create: {
        householdId: household.id,
        kind: 'kroger',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: 'cart.basic:write profile.compact',
      },
      update: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      },
    });
    // Back to the app (the web proxy serves the SPA at /).
    reply.redirect('/?kroger=linked');
  });

  // Sync real prices for a shopping list's items (or explicit itemIds) at a linked provider.
  app.post('/integrations/kroger/sync-prices', async (req, reply) => {
    const cfg = krogerConfig();
    if (!cfg) {
      reply.code(503);
      return { message: 'Kroger not configured' };
    }
    const body = (req.body ?? {}) as { providerId?: string; shoppingListId?: string; itemIds?: string[] };
    if (!body.providerId) {
      reply.code(400);
      return { message: 'providerId required' };
    }
    const provider = await prisma.provider.findUniqueOrThrow({ where: { id: body.providerId } });

    let itemIds = body.itemIds ?? [];
    if (body.shoppingListId) {
      const list = await prisma.shoppingList.findUniqueOrThrow({
        where: { id: body.shoppingListId },
        include: { items: true },
      });
      itemIds = list.items.map((i) => i.canonicalItemId);
    }
    if (!itemIds.length) {
      reply.code(400);
      return { message: 'Nothing to sync — pass shoppingListId or itemIds' };
    }
    return syncPrices(cfg, provider, itemIds);
  });

  // Push a shopping list's items (assigned to this provider, or all) into the user's cart.
  app.post('/shopping-lists/:id/kroger-cart', async (req, reply) => {
    const cfg = krogerConfig();
    if (!cfg) {
      reply.code(503);
      return { message: 'Kroger not configured' };
    }
    const { id } = req.params as { id: string };
    const household = await getHousehold(req);
    const userToken = await getUserToken(cfg, household.id);
    if (!userToken) {
      reply.code(401);
      return { message: 'Cart not authorized — visit /api/integrations/kroger/authorize first' };
    }

    // Use the SAME per-item selection the Build view shows: the chosen product, or the best
    // option when none was picked. No separate "auto-select" step required.
    const providerFilter = (req.body as { providerId?: string } | null)?.providerId;
    const options = await computeItemOptions(household.id, id);
    const picks = options
      .map((it) => it.options.find((o) => o.productId === it.chosenProductId) ?? it.options[0])
      .filter((o): o is NonNullable<typeof o> => !!o)
      .filter((o) => !providerFilter || o.providerId === providerFilter);

    const products = await prisma.providerProduct.findMany({
      where: { id: { in: picks.map((o) => o.productId) }, upc: { not: null } },
      select: { id: true, upc: true },
    });
    const upcById = new Map(products.map((p) => [p.id, p.upc!]));
    const push = picks
      .filter((o) => upcById.has(o.productId))
      .map((o) => ({ upc: upcById.get(o.productId)!, quantity: o.packsNeeded }));

    if (!push.length) {
      reply.code(422);
      return {
        message:
          'Nothing to add for this store — its items have no synced Kroger product with a UPC. ' +
          'Run a Fry\'s price sync, or check that items are assigned to Fry\'s in Build.',
      };
    }
    await addToCart(cfg, userToken, push);
    return { pushed: push.length, items: push };
  });

  // ---- Fry's digital coupons (fetched by the host-side Playwright script; clipping is
  // approval-gated: the script only clips status=approved) ----
  app.get('/integrations/kroger/coupons', async (req) => {
    const household = await getHousehold(req);
    const { status } = req.query as { status?: string };
    const now = new Date();
    return prisma.krogerCoupon.findMany({
      where: {
        householdId: household.id,
        status: status ?? 'proposed',
        OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
      },
      orderBy: [{ matchedItemName: { sort: 'asc', nulls: 'last' } }, { value: { sort: 'desc', nulls: 'last' } }],
      take: 300,
    });
  });

  app.post('/integrations/kroger/coupons/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    return prisma.krogerCoupon.update({ where: { id }, data: { status: 'approved' } });
  });

  app.post('/integrations/kroger/coupons/:id/dismiss', async (req) => {
    const { id } = req.params as { id: string };
    return prisma.krogerCoupon.update({ where: { id }, data: { status: 'dismissed' } });
  });

  // Bulk-approve everything matched to the household's items (still requires the clip run).
  app.post('/integrations/kroger/coupons/approve-matched', async (req) => {
    const household = await getHousehold(req);
    const res = await prisma.krogerCoupon.updateMany({
      where: { householdId: household.id, status: 'proposed', matchedItemName: { not: null } },
      data: { status: 'approved' },
    });
    return { approved: res.count };
  });

  // Costco price import from the bookmarklet (paste). Records under the Costco provider.
  app.post('/integrations/costco/receipts', async (req, reply) => {
    const data = costcoImportSchema.parse(req.body);
    const household = await getHousehold(req);
    try {
      const res = await recordCostcoPrices(household.id, data.items);
      return res;
    } catch (err) {
      reply.code(400);
      return { message: err instanceof Error ? err.message : String(err) };
    }
  });

  // Free-form paste → local LLM extracts {name, size, price} rows (preview only; saving is a
  // separate confirmed step via POST /providers/:id/bulk-prices).
  app.post('/integrations/parse-prices', async (req, reply) => {
    const { text } = parsePricesSchema.parse(req.body);
    try {
      const raw = await chatJson({
        baseUrl: env.OCR_LOCAL_BASE_URL,
        model: env.LLM_MODEL,
        apiKey: env.OCR_LOCAL_API_KEY || undefined,
        system:
          'You extract grocery products and their prices from pasted text (receipts, listings, ' +
          'notes). Return JSON {"items":[{"name","size","price"}]}: name = the product (clean, ' +
          'no price/size), size = pack/quantity text like "4 lb" or "2 L" if present else omit, ' +
          'price = the number in dollars. Skip totals, tax, subtotals, and non-products. ' +
          'Only include lines that clearly have a price.',
        prompt: text,
        maxTokens: 3000,
        timeoutMs: 60000,
      });
      const obj = raw as { items?: unknown };
      const items = z.array(parsedPriceSchema).parse(Array.isArray(raw) ? raw : (obj.items ?? []));
      return { items };
    } catch (err) {
      reply.code(502);
      return {
        message:
          err instanceof Error && /HTTP|fetch|ECONN|timeout/i.test(err.message)
            ? 'Local LLM unreachable — is Ollama running and bound to 0.0.0.0? (see docs/local-ocr.md)'
            : `Parse failed: ${err instanceof Error ? err.message : err}`,
      };
    }
  });

  // Parse ONE pasted product blurb into brand/size/price (name is already known — the list
  // item). Used by the shopping-list "check price" capture.
  app.post('/integrations/parse-price-one', async (req, reply) => {
    const { text, itemName } = parsePriceOneSchema.parse(req.body);
    try {
      const raw = await chatJson({
        baseUrl: env.OCR_LOCAL_BASE_URL,
        model: env.LLM_MODEL,
        apiKey: env.OCR_LOCAL_API_KEY || undefined,
        system:
          'You extract product attributes from a pasted grocery product description. Return ' +
          'JSON {"brand","size","price"}: brand = the manufacturer/brand name only (e.g. ' +
          '"Kirkland Signature", "Great Value") NOT the food type; size = pack/quantity text ' +
          '(e.g. "4 lb", "2 L", "24 ct") if present; price = the dollar amount as a number. ' +
          'Omit a field if not present.',
        prompt: itemName ? `Item: ${itemName}\n\n${text}` : text,
        maxTokens: 500,
        timeoutMs: 60000,
      });
      return parsedPriceOneSchema.parse(raw);
    } catch (err) {
      reply.code(502);
      return {
        message:
          err instanceof Error && /HTTP|fetch|ECONN|timeout/i.test(err.message)
            ? 'Local LLM unreachable — is Ollama running and bound to 0.0.0.0?'
            : `Parse failed: ${err instanceof Error ? err.message : err}`,
      };
    }
  });

  // ---- Walmart / Safeway assisted cart links (no middleman, first-party prices) ----
  app.get('/shopping-lists/:id/cart-links', async (req) => {
    const { id } = req.params as { id: string };
    const list = await prisma.shoppingList.findUniqueOrThrow({
      where: { id },
      include: { items: { include: { canonicalItem: true } } },
    });
    const items = list.items
      .filter((i) => i.status === 'pending')
      .map((i) => ({ name: i.canonicalItem.name, quantity: Number(i.quantityNeeded) }));
    return {
      walmart: walmartCartLink(items),
      safeway: safewaySearchLinks(items),
    };
  });
}
