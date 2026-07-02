import { chromium } from 'playwright';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
async function probe(name, opts) {
  try {
    const browser = await chromium.launch({
      headless: opts.headless,
      ...(opts.channel ? { channel: opts.channel } : {}),
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const ctx = await browser.newContext({ userAgent: UA });
    const page = await ctx.newPage();
    const res = await page.goto('https://www.frysfood.com/savings/cl/coupons', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(3000);
    const title = await page.title();
    console.log(`${name}: HTTP ${res?.status()} title="${title.slice(0,60)}"`);
    await browser.close();
  } catch (e) {
    console.log(`${name}: FAIL ${String(e.message).split('\n')[0]}`);
  }
}
await probe('headless+stealth+UA', { headless: true });
await probe('chrome-channel-headless', { headless: true, channel: 'chrome' });
