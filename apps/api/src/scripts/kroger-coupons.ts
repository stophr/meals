// Fry's/Kroger digital-coupon integration. Kroger's web properties reject non-browser TLS
// (Akamai), so this runs a real Chromium on the HOST via Playwright — the approach every
// working community clipper uses. Clipping is approval-gated through the app UI.
//
// One-time setup:   pnpm --filter @meals/api exec playwright install chromium
// 1. Login (headed; you type your Fry's credentials, handle any CAPTCHA):
//      pnpm --filter @meals/api exec tsx src/scripts/kroger-coupons.ts --login
// 2. Fetch coupons -> proposals in the app (matched to your items, UPC-first):
//      pnpm --filter @meals/api exec tsx src/scripts/kroger-coupons.ts
// 3. Approve/dismiss in the app UI (Shop tab -> Coupons), then clip ONLY approved:
//      pnpm --filter @meals/api exec tsx src/scripts/kroger-coupons.ts --clip-approved
//
// Session state lives in storage/kroger-web-state.json (gitignored).

import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import { prisma, PriceSource } from '@meals/db';
import { normalizeName, similarity } from '@meals/core';

const HOST = process.env.KROGER_WEB_HOST ?? 'https://www.frysfood.com';
const STATE_PATH = 'storage/kroger-web-state.json';

interface RawCoupon {
  id?: string;
  krogerCouponNumber?: string;
  brandName?: string;
  shortDescription?: string;
  description?: string;
  savings?: string;
  offerPrice?: number;
  expirationDate?: string;
  upcs?: string[];
  status?: string;
  canBeRemoved?: boolean;
}

interface NormalCoupon {
  id: string;
  description: string;
  brand?: string;
  valueText?: string;
  value?: number;
  expiresAt?: Date;
  upcs: string[];
}

// The internal API moves; try known shapes in order and use whichever answers with coupons.
const FETCH_CANDIDATES = [
  '/atlas/v1/savings-coupons/v1/coupons?filter.status=unclipped&page.size=400',
  '/atlas/v1/savings-coupons/v1/coupons?page.size=400',
  '/cl/api/coupons?filter.status=unclipped&page=1&pageSize=400',
];
const CLIP_CANDIDATES = [
  { path: '/atlas/v1/savings-coupons/v1/clip', body: (id: string) => ({ couponId: id }) },
  { path: '/cl/api/coupons/clip', body: (id: string) => ({ couponId: id }) },
];

function normalize(raw: RawCoupon): NormalCoupon | null {
  const id = raw.id ?? raw.krogerCouponNumber;
  const description = raw.shortDescription ?? raw.description;
  if (!id || !description) return null;
  const valueText = raw.savings ?? (raw.offerPrice ? `$${raw.offerPrice}` : undefined);
  const valueMatch = valueText?.match(/\$\s?(\d+(?:\.\d+)?)/);
  return {
    id: String(id),
    description,
    brand: raw.brandName,
    valueText,
    value: valueMatch ? Number(valueMatch[1]) : undefined,
    expiresAt: raw.expirationDate ? new Date(raw.expirationDate) : undefined,
    upcs: (raw.upcs ?? []).map(String),
  };
}

/** Dig a coupon array out of whatever envelope the endpoint used. */
function extractCoupons(payload: unknown): RawCoupon[] {
  if (Array.isArray(payload)) return payload as RawCoupon[];
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['coupons', 'data', 'results', 'pageContent']) {
      const v = obj[key];
      if (Array.isArray(v)) return v as RawCoupon[];
      if (v && typeof v === 'object') {
        const nested = extractCoupons(v);
        if (nested.length) return nested;
      }
    }
  }
  return [];
}

async function openContext(headed = false): Promise<{ ctx: BrowserContext; page: Page }> {
  const browser = await chromium.launch({ headless: !headed });
  const ctx = await browser.newContext({
    ...(existsSync(STATE_PATH) ? { storageState: STATE_PATH } : {}),
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  return { ctx, page };
}

async function login() {
  mkdirSync('storage', { recursive: true });
  const { ctx, page } = await openContext(true);
  console.log(`Opening ${HOST}/signin …`);
  await page.goto(`${HOST}/signin`, { waitUntil: 'domcontentloaded' });
  console.log('');
  console.log('  1. Sign in with your Fry\'s account in the browser window');
  console.log('  2. Wait until you are fully signed in (your name/account visible)');
  console.log('  3. Come back to THIS terminal and press Enter — do NOT close the browser');
  console.log('');
  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });
  await ctx.storageState({ path: STATE_PATH });
  console.log(`Session saved to ${STATE_PATH}. Closing browser.`);
  await ctx.browser()?.close();
  process.stdin.pause();
}

async function inPageJson(page: Page, path: string): Promise<unknown> {
  return page.evaluate(async (p) => {
    const res = await fetch(p, { headers: { accept: 'application/json' }, credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }, path);
}

async function fetchAndPropose() {
  // Coupon BROWSING needs no login — anonymous context works (login only gates clipping).
  // If Akamai blocks headless, retry with --headed.
  const headed = process.argv.includes('--headed');
  const household = await prisma.household.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const { ctx, page } = await openContext(headed);
  await page.goto(`${HOST}/savings/cl/coupons`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000); // let the SPA authenticate its API session

  let coupons: NormalCoupon[] = [];
  let endpointUsed = '';
  for (const path of FETCH_CANDIDATES) {
    try {
      const payload = await inPageJson(page, path);
      const raw = extractCoupons(payload);
      if (raw.length) {
        coupons = raw.map(normalize).filter((c): c is NormalCoupon => !!c);
        endpointUsed = path;
        break;
      }
    } catch {
      /* try next candidate */
    }
  }
  await ctx.browser()?.close();
  if (!coupons.length) {
    throw new Error(
      'No coupons retrieved — the internal endpoint may have moved. Open the coupons page in ' +
        'your browser devtools, note the XHR path, and add it to FETCH_CANDIDATES.',
    );
  }
  console.log(`fetched ${coupons.length} coupons via ${endpointUsed}`);

  // Match: UPC-exact against synced Fry's products, then fuzzy vs items on active lists.
  const products = await prisma.providerProduct.findMany({
    where: {
      upc: { not: null },
      storeLocation: { providers: { some: { householdId: household.id } } },
    },
    include: { canonicalItem: { select: { name: true } } },
  });
  const byUpc = new Map(products.map((p) => [p.upc!, p]));
  const listItems = await prisma.shoppingListItem.findMany({
    where: { shoppingList: { householdId: household.id }, status: 'pending' },
    include: { canonicalItem: { select: { name: true } } },
  });
  const listNames = [...new Set(listItems.map((i) => i.canonicalItem.name))];

  let matched = 0;
  for (const c of coupons) {
    const product = c.upcs.map((u) => byUpc.get(u)).find(Boolean);
    let matchedItemName: string | undefined;
    let matchedProductId: string | undefined;
    if (product) {
      matchedProductId = product.id;
      matchedItemName = product.canonicalItem?.name ?? product.rawName;
    } else {
      const target = normalizeName(`${c.brand ?? ''} ${c.description}`);
      let best = 0;
      for (const name of listNames) {
        const s = similarity(target, name);
        if (s > best) {
          best = s;
          if (s >= 0.55) matchedItemName = name;
        }
      }
    }
    if (matchedItemName) matched++;
    await prisma.krogerCoupon.upsert({
      where: { id: c.id },
      create: {
        id: c.id,
        householdId: household.id,
        description: c.description,
        brand: c.brand,
        valueText: c.valueText,
        value: c.value?.toFixed(2),
        expiresAt: c.expiresAt,
        upcs: c.upcs,
        matchedProductId,
        matchedItemName,
      },
      update: {
        valueText: c.valueText,
        value: c.value?.toFixed(2),
        expiresAt: c.expiresAt,
        matchedProductId,
        matchedItemName,
        fetchedAt: new Date(),
      },
    });
  }
  console.log(
    `proposed ${coupons.length} coupons (${matched} matched to your items/list) — approve in the app, then run --clip-approved`,
  );
}

async function clipApproved() {
  if (!existsSync(STATE_PATH)) throw new Error(`No session — run with --login first`);
  const approved = await prisma.krogerCoupon.findMany({ where: { status: 'approved' } });
  if (!approved.length) {
    console.log('Nothing approved — approve coupons in the app first (Shop tab → Coupons).');
    return;
  }
  console.log(`clipping ${approved.length} approved coupon(s)…`);

  const { ctx, page } = await openContext(false);
  await page.goto(`${HOST}/savings/cl/coupons`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  let clipped = 0;
  let failed = 0;
  for (const coupon of approved) {
    let ok = false;
    for (const cand of CLIP_CANDIDATES) {
      try {
        await page.evaluate(
          async ({ path, body }) => {
            const res = await fetch(path, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              credentials: 'include',
              body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
          },
          { path: cand.path, body: cand.body(coupon.id) },
        );
        ok = true;
        break;
      } catch {
        /* try next candidate */
      }
    }
    await prisma.krogerCoupon.update({
      where: { id: coupon.id },
      data: ok ? { status: 'clipped', clippedAt: new Date() } : { status: 'failed' },
    });
    if (ok) {
      clipped++;
      // Coupon-adjusted price for the optimizer, when we know the product + $ value.
      if (coupon.matchedProductId && coupon.value) {
        const latest = await prisma.priceObservation.findFirst({
          where: { providerProductId: coupon.matchedProductId },
          orderBy: { observedAt: 'desc' },
        });
        if (latest) {
          const adjusted = Math.max(0.01, Number(latest.price) - Number(coupon.value));
          await prisma.priceObservation.create({
            data: {
              providerProductId: coupon.matchedProductId,
              price: adjusted.toFixed(2),
              isDeal: true,
              dealType: 'digital-coupon',
              regularPrice: latest.price,
              validTo: coupon.expiresAt ?? new Date(Date.now() + 7 * 86_400_000),
              source: PriceSource.SCRAPE,
              rawText: `${coupon.valueText ?? ''} ${coupon.description}`.trim(),
            },
          });
        }
      }
    } else failed++;
    await page.waitForTimeout(800); // gentle pacing
  }
  await ctx.browser()?.close();
  console.log(`DONE — clipped ${clipped}, failed ${failed} (failed coupons marked; re-approve to retry)`);
}

const mode = process.argv.includes('--login')
  ? login
  : process.argv.includes('--clip-approved')
    ? clipApproved
    : fetchAndPropose;

mode()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
