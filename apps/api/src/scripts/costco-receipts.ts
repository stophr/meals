// Costco digital-receipt import. As a member, your in-warehouse purchases appear under
// costco.com "Orders & Purchases" as structured data — item numbers, descriptions, and the
// REAL shelf prices you paid (unlike costco.com catalog prices, which carry an online
// premium). This pulls them with your own session (Playwright, same pattern as the Kroger
// coupon tool: Costco also runs browser-fingerprint bot protection) and records prices under
// the Costco provider. Item numbers become product SKUs; confident name matches link to
// canonical items so the optimizer can use them.
//
//   pnpm --filter @meals/api exec playwright install chromium        # once (done already)
//   pnpm --filter @meals/api exec tsx src/scripts/costco-receipts.ts --login   # once
//   pnpm --filter @meals/api exec tsx src/scripts/costco-receipts.ts [--months 3] [--headed]

import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import { prisma, PriceSource } from '@meals/db';
import { matchLine, normalizeName } from '@meals/core';

const HOST = 'https://www.costco.com';
const STATE_PATH = 'storage/costco-web-state.json';

interface ReceiptLine {
  itemNumber: string;
  description: string;
  price: number;
  date: Date;
}

async function openContext(headed = false): Promise<{ ctx: BrowserContext; page: Page }> {
  const browser = await chromium.launch({ headless: !headed });
  const ctx = await browser.newContext({
    ...(existsSync(STATE_PATH) ? { storageState: STATE_PATH } : {}),
    viewport: { width: 1280, height: 900 },
  });
  return { ctx, page: await ctx.newPage() };
}

async function login() {
  mkdirSync('storage', { recursive: true });
  const { ctx, page } = await openContext(true);
  console.log(`Opening ${HOST} sign-in …`);
  await page.goto(`${HOST}/logon`, { waitUntil: 'domcontentloaded' });
  console.log('');
  console.log('  1. Sign in with your Costco membership account');
  console.log('  2. When fully signed in, come back HERE and press Enter (leave the browser open)');
  console.log('');
  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });
  await ctx.storageState({ path: STATE_PATH });
  console.log(`Session saved to ${STATE_PATH}.`);
  await ctx.browser()?.close();
  process.stdin.pause();
}

/** Candidate internal endpoints for warehouse receipts — Costco moves these occasionally. */
const RECEIPT_QUERIES: { name: string; run: (page: Page, months: number) => Promise<ReceiptLine[]> }[] = [
  {
    name: 'graphql receiptsWithCounts',
    run: async (page, months) => {
      const end = new Date();
      const start = new Date(end.getTime() - months * 30 * 86_400_000);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const payload = await page.evaluate(
        async ({ startDate, endDate }) => {
          const res = await fetch('https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql', {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json-patch+json', accept: 'application/json' },
            body: JSON.stringify({
              query: `query receiptsWithCounts($startDate: String!, $endDate: String!) {
                receiptsWithCounts(startDate: $startDate, endDate: $endDate) {
                  receipts { transactionDate warehouseName itemArray { itemNumber itemDescription01 amount } }
                }
              }`,
              variables: { startDate, endDate },
            }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        },
        { startDate: fmt(start), endDate: fmt(end) },
      );
      const receipts =
        (payload as { data?: { receiptsWithCounts?: { receipts?: unknown[] } } }).data
          ?.receiptsWithCounts?.receipts ?? [];
      const lines: ReceiptLine[] = [];
      for (const r of receipts as {
        transactionDate?: string;
        itemArray?: { itemNumber?: string | number; itemDescription01?: string; amount?: number }[];
      }[]) {
        const date = r.transactionDate ? new Date(r.transactionDate) : new Date();
        for (const item of r.itemArray ?? []) {
          if (item.itemNumber == null || !item.itemDescription01 || item.amount == null) continue;
          if (item.amount <= 0) continue; // returns/discount rows
          lines.push({
            itemNumber: String(item.itemNumber),
            description: item.itemDescription01,
            price: item.amount,
            date,
          });
        }
      }
      return lines;
    },
  },
];

async function fetchReceipts() {
  if (!existsSync(STATE_PATH)) throw new Error('No session — run with --login first');
  const months = Number(
    process.argv.includes('--months') ? process.argv[process.argv.indexOf('--months') + 1] : 3,
  );
  const headed = process.argv.includes('--headed');
  const household = await prisma.household.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const costco = await prisma.provider.findFirst({
    where: { householdId: household.id, name: { startsWith: 'Costco' } },
  });
  if (!costco) throw new Error('No Costco provider — create one first');

  const { ctx, page } = await openContext(headed);
  await page.goto(`${HOST}/OrderStatusCmd`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000); // let the SPA establish its API auth

  let lines: ReceiptLine[] = [];
  let used = '';
  for (const q of RECEIPT_QUERIES) {
    try {
      lines = await q.run(page, months);
      if (lines.length) {
        used = q.name;
        break;
      }
    } catch {
      /* try next */
    }
  }
  await ctx.browser()?.close();
  if (!lines.length) {
    throw new Error(
      'No receipt lines retrieved. Either no warehouse purchases in the window, the session ' +
        'expired (re-run --login), or Costco moved the endpoint — open Orders & Purchases with ' +
        'devtools and add the new XHR to RECEIPT_QUERIES.',
    );
  }
  console.log(`fetched ${lines.length} receipt line(s) via ${used} (last ${months} months)`);

  // Latest price per item number wins.
  const latest = new Map<string, ReceiptLine>();
  for (const line of lines) {
    const prev = latest.get(line.itemNumber);
    if (!prev || line.date > prev.date) latest.set(line.itemNumber, line);
  }

  const items = await prisma.canonicalItem.findMany({ where: { householdId: household.id } });
  const candidates = items.map((i) => ({ productId: i.id, text: i.name }));

  let recorded = 0;
  let linked = 0;
  for (const line of latest.values()) {
    // Costco receipt abbreviations are rough ("KS ORG EVOO") — only confident matches link.
    const match = candidates.length ? matchLine(line.description, candidates) : null;
    const canonicalItemId = match?.decision === 'auto' ? match.productId : null;
    if (canonicalItemId) linked++;

    const product = await prisma.providerProduct.upsert({
      where: { providerId_upc: { providerId: costco.id, upc: `costco:${line.itemNumber}` } },
      create: {
        providerId: costco.id,
        canonicalItemId,
        rawName: line.description,
        sku: line.itemNumber,
        upc: `costco:${line.itemNumber}`,
      },
      update: { ...(canonicalItemId ? { canonicalItemId } : {}) },
    });
    await prisma.priceObservation.create({
      data: {
        providerProductId: product.id,
        price: line.price.toFixed(2),
        source: PriceSource.SCRAPE,
        observedAt: line.date,
        validTo: new Date(line.date.getTime() + 60 * 86_400_000), // warehouse prices move slowly
        rawText: `${line.description} #${line.itemNumber}`,
      },
    });
    await prisma.productAlias.upsert({
      where: {
        providerId_normalizedRawName: {
          providerId: costco.id,
          normalizedRawName: normalizeName(line.description),
        },
      },
      create: {
        providerId: costco.id,
        normalizedRawName: normalizeName(line.description),
        providerProductId: product.id,
      },
      update: { providerProductId: product.id },
    });
    recorded++;
  }
  console.log(
    `DONE — ${recorded} Costco prices recorded (${linked} auto-linked to your items; unlinked ones link as the catalog grows or via receipt review)`,
  );
}

const mode = process.argv.includes('--login') ? login : fetchReceipts;
mode()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
