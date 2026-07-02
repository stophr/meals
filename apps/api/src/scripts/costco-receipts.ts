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

interface ReceiptLine {
  itemNumber: string;
  description: string;
  price: number;
  date: Date;
}

const PROFILE_DIR = 'storage/costco-chrome-profile';

// Costco's Akamai denies bundled/headless Chromium outright (verified 403). Best shot is the
// REAL system Chrome, a persistent on-disk profile, and no automation flags — headed. Even
// so it may be blocked; if the window shows "Access Denied", use receipt-photo OCR instead
// (Costco receipts OCR cleanly). Uses a persistent context (its own storage) rather than
// storageState.
async function openContext(headed = false): Promise<{ ctx: BrowserContext; page: Page }> {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !headed,
    channel: 'chrome',
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });
  return { ctx, page: ctx.pages()[0] ?? (await ctx.newPage()) };
}

async function login() {
  const { ctx, page } = await openContext(true);
  console.log(`Opening ${HOST} …`);
  try {
    await page.goto(`${HOST}/`, { waitUntil: 'domcontentloaded' });
  } catch {
    /* keep the window open regardless */
  }
  console.log('');
  console.log('  1. If you see "Access Denied", Costco blocked automation — close and use');
  console.log('     receipt-photo OCR instead (Pantry/receipt upload). Otherwise:');
  console.log('  2. Sign in, open Orders & Purchases once, then press Enter here.');
  console.log('     The session persists in the Chrome profile for the fetch step.');
  console.log('');
  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });
  await ctx.close();
  console.log(`Profile saved (${PROFILE_DIR}).`);
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
  if (!existsSync(PROFILE_DIR)) throw new Error('No session — run with --login first');
  const months = Number(
    process.argv.includes('--months') ? process.argv[process.argv.indexOf('--months') + 1] : 3,
  );
  const household = await prisma.household.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const costco = await prisma.provider.findFirst({
    where: { householdId: household.id, name: { startsWith: 'Costco' } },
  });
  if (!costco) throw new Error('No Costco provider — create one first');

  // Headless is 403'd by Costco; fetch runs headed too (leave the window alone while it works).
  const { ctx, page } = await openContext(true);
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
  await ctx.close();
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
