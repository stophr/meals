/**
 * Crawl the full Fry's/Kroger catalog into the shared global Product corpus so users can search
 * and build shopping lists from the whole store. Kroger has no "dump all" endpoint — we sweep a
 * broad term dictionary (canonical item names + a grocery/brand seed list + IFPS produce words),
 * paginate each term to Kroger's offset cap, and upsert every returned product via
 * ingestKrogerProduct (dedupes by UPC, links a CanonicalItem, keeps the image URL).
 *
 * Respects the Products API daily cap: at most CATALOG_MAX_CALLS_PER_DAY requests per rolling
 * 24h window (sleeps until the window resets), and stops on repeated 429s. Fully resumable — a
 * checkpoint of completed terms is persisted to data/catalog-crawl-state.json, so re-running (or
 * a restart after a crash) continues where it left off. Idempotent.
 *
 * Usage: pnpm --filter @meals/api exec tsx src/scripts/crawl-kroger-catalog.ts [--location <id>]
 *   [--max-calls-per-day 9000] [--budget <total calls this run>]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { prisma } from '@meals/db';
import { krogerConfig, getAppToken, krogerLocationId } from '../lib/kroger.js';
import { searchProducts, PLU_CODES } from '@meals/ingestion';
import { ingestKrogerProduct } from '../lib/productCorpus.js';

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Anchor at the repo-root data/ dir regardless of CWD (pnpm --filter runs from apps/api).
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../data');
const STATE_FILE = join(DATA_DIR, 'catalog-crawl-state.json');
const PAGE = 50; // Kroger max filter.limit
const MAX_START = 200; // offset cap (start 0,50,100,150,200 => up to 250 per term)

// Broad grocery + brand seed terms to widen coverage beyond our canonical-item names.
const SEED_TERMS = `milk cheese butter yogurt cream eggs bread bagel tortilla bun roll muffin
chicken beef pork turkey bacon sausage ham steak ground fish salmon tuna shrimp tofu
apple banana orange grape strawberry blueberry lemon lime avocado tomato potato onion garlic
carrot celery lettuce spinach broccoli pepper cucumber mushroom corn beans peas squash
rice pasta noodle flour sugar salt pepper oil vinegar olive coconut honey syrup jam peanut butter
cereal oatmeal granola cracker chip pretzel popcorn cookie candy chocolate gum
soda water juice coffee tea beer wine soup broth sauce ketchup mustard mayo dressing salsa
frozen pizza icecream waffle nugget fries vegetable dinner
canned tomato beans tuna soup corn
soap shampoo conditioner toothpaste deodorant lotion razor
paper towel toilet tissue napkin foil wrap bag
detergent bleach cleaner dish sponge trash
diaper wipes formula baby
dog cat pet food treat litter
vitamin medicine aspirin bandage cough allergy
spice cinnamon vanilla garlic powder oregano basil cumin paprika
kraft heinz nestle general mills kelloggs pepsi cocacola frito lay campbell nabisco
tyson hormel oscar mayer land olakes chobani dannon yoplait
tide gain dawn clorox lysol charmin bounty scott kleenex huggies pampers
gatorade tropicana minute maid folgers starbucks lipton
oreo ritz cheerios doritos lays pringles hersheys mms snickers
progresso barilla ragu prego hunts del monte green giant birds eye
private selection simple truth kroger fry`
  .split(/\s+/)
  .filter(Boolean);

function loadState(): { done: string[] } {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    } catch {
      /* fall through to fresh */
    }
  }
  return { done: [] };
}
function saveState(done: Set<string>) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ done: [...done], savedAt: new Date().toISOString() }));
}

async function main() {
  const cfg = krogerConfig();
  if (!cfg) {
    console.error('No Kroger config (KROGER_CLIENT_ID / KROGER_CLIENT_SECRET).');
    process.exit(1);
  }
  let loc = arg('--location');
  if (!loc) {
    const providers = await prisma.provider.findMany();
    loc = providers.map((p) => krogerLocationId(p)).find((x): x is string => !!x);
  }
  if (!loc) {
    console.error("No Kroger location — link a Fry's store or pass --location <id>.");
    process.exit(1);
  }

  const maxPerDay = Number(arg('--max-calls-per-day') ?? process.env.CATALOG_MAX_CALLS_PER_DAY ?? 9000);
  const budget = Number(arg('--budget') ?? Infinity); // optional hard cap for this run

  // Produce commodity words from the IFPS PLU list.
  const produceWords = [
    ...new Set(Object.values(PLU_CODES).map((v) => v.trim().split(/\s+/).pop()!.toLowerCase().replace(/[^a-z]/g, ''))),
  ].filter((t) => t.length >= 3);

  // Our known canonical item names — the highest-quality search terms.
  const canonical = (await prisma.canonicalItem.findMany({ select: { name: true } })).map((c) => c.name.toLowerCase().trim());

  const terms = [...new Set([...canonical, ...SEED_TERMS, ...produceWords])]
    .filter((t) => t && t.length >= 3)
    .sort();

  const state = loadState();
  const done = new Set(state.done);
  const todo = terms.filter((t) => !done.has(t));
  console.log(
    `Catalog crawl @ ${loc}: ${terms.length} terms (${done.size} already done, ${todo.length} to go). ` +
      `Cap ${maxPerDay}/day.`,
  );

  let calls = 0;
  let windowStart = Date.now();
  let created = 0;
  let updated = 0;
  let quotaHits = 0;
  const start = Date.now();

  for (const [i, term] of todo.entries()) {
    for (let s = 0; s <= MAX_START; s += PAGE) {
      // Rolling daily-cap gate.
      if (calls >= maxPerDay) {
        const waitMs = 86_400_000 - (Date.now() - windowStart);
        if (waitMs > 0) {
          console.log(`\n[daily cap ${maxPerDay} reached] sleeping ${Math.round(waitMs / 3600000)}h; state saved.`);
          saveState(done);
          await sleep(waitMs);
        }
        windowStart = Date.now();
        calls = 0;
      }
      if (calls >= budget) {
        console.log('\n[run budget reached] stopping; state saved.');
        saveState(done);
        await finish();
        return;
      }

      await sleep(400); // pace politely
      let prods;
      try {
        const token = await getAppToken(cfg);
        prods = await searchProducts(cfg, token, { term, locationId: loc, limit: PAGE, start: s, timeoutMs: 12000 });
        calls++;
        quotaHits = 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        calls++;
        if (/HTTP 429/.test(msg)) {
          quotaHits++;
          console.log(`  quota 429 (#${quotaHits}) — backing off`);
          if (quotaHits >= 5) {
            console.log('\n[repeated 429 = daily quota exhausted] saving + exiting; resume by re-running.');
            saveState(done);
            await finish();
            return;
          }
          await sleep(60_000);
          s -= PAGE; // retry this page
          continue;
        }
        if (/HTTP 4\d\d/.test(msg)) break; // term returned nothing useful — next term
        await sleep(2000);
        continue;
      }

      for (const p of prods) {
        const r = await ingestKrogerProduct(p).catch(() => 'skipped' as const);
        if (r === 'created') created++;
        else if (r === 'updated') updated++;
      }
      if (prods.length < PAGE) break; // last page for this term
    }

    done.add(term);
    if (i % 25 === 0) {
      saveState(done);
      const total = await prisma.product.count();
      const rate = Math.round((calls / ((Date.now() - windowStart) / 1000)) * 60);
      console.log(
        `  [${done.size}/${terms.length}] "${term}" | corpus=${total} | +${created}/~${updated} | ` +
          `calls today=${calls} (${rate}/min)`,
      );
    }
  }

  saveState(done);
  await finish();

  async function finish() {
    const total = await prisma.product.count();
    const withImg = await prisma.product.count({ where: { imageUrl: { not: null } } });
    console.log(
      `\nDone this pass in ${Math.round((Date.now() - start) / 60000)}m. ` +
        `Corpus: ${total} products (${withImg} with image URL). created=${created} updated=${updated}. ` +
        `Terms complete: ${done.size}/${terms.length}.`,
    );
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
