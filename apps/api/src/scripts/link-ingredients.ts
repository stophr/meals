// Batch-link free-text recipe ingredients to canonical pantry items, bootstrapping the
// canonical catalog from the recipe corpus as it goes.
//
// Pass 1 streams every unlinked RecipeIngredient and aggregates by normalized ingredient
// name (2.16M rows collapse to ~tens of thousands of keys; frequency is Zipf-heavy).
// Each key is then resolved, most-frequent first:
//   1. exact normKey match to an existing canonical item        -> link
//   2. fuzzy match >= 0.85 (token-indexed, so it scales)        -> link
//   3. optional local-LLM pass: clean the name ("boneless skinless chicken breast halves"
//      -> "chicken breast") and merge synonyms with fuzzy candidates
//   4. no match but frequent (>= --create-threshold)            -> create canonical item
// Pass 2 re-streams the rows and bulk-writes canonicalItemId per resolved key.
//
// Idempotent: linked rows are never revisited; created items dedup by normKey.
//
// Usage:
//   pnpm --filter @meals/api exec tsx src/scripts/link-ingredients.ts \
//     [--llm] [--llm-base-url URL] [--llm-model NAME] [--llm-max N] \
//     [--create-threshold N] [--limit-keys N] [--dry-run]

import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { prisma } from '@meals/db';
import type { Unit } from '@meals/db';
import {
  parseIngredientLine,
  normalizeName,
  buildNormKey,
  similarity,
  dimensionOf,
  BASE_UNIT,
} from '@meals/core';
import type { UnitDimension } from '@meals/shared';
import { chatJson } from '@meals/ingestion';

interface Args {
  llm: boolean;
  llmBaseUrl: string;
  llmModel: string;
  llmMax: number;
  createThreshold: number;
  limitKeys: number;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    llm: argv.includes('--llm'),
    llmBaseUrl: get('--llm-base-url') ?? 'http://localhost:11434/v1',
    llmModel: get('--llm-model') ?? 'qwen2.5:7b',
    llmMax: Number(get('--llm-max') ?? 400),
    createThreshold: Number(get('--create-threshold') ?? 50),
    limitKeys: Number(get('--limit-keys') ?? Infinity),
    dryRun: argv.includes('--dry-run'),
  };
}

// ---------------------------------------------------------------------------
// Token-indexed fuzzy lookup over canonical items (scales past a few thousand items).
// ---------------------------------------------------------------------------

interface IndexedItem {
  id: string;
  name: string;
  key: string;
}

class ItemIndex {
  private byKey = new Map<string, IndexedItem>();
  private byToken = new Map<string, IndexedItem[]>();

  add(item: IndexedItem) {
    this.byKey.set(item.key, item);
    for (const tok of new Set(item.key.split(' '))) {
      if (tok.length < 2) continue;
      const list = this.byToken.get(tok);
      if (list) list.push(item);
      else this.byToken.set(tok, [item]);
    }
  }

  exact(key: string): IndexedItem | undefined {
    return this.byKey.get(key);
  }

  /** Best fuzzy match among items sharing at least one token. */
  best(key: string): { item: IndexedItem; score: number } | null {
    const seen = new Set<IndexedItem>();
    for (const tok of new Set(key.split(' '))) {
      for (const item of this.byToken.get(tok) ?? []) seen.add(item);
    }
    let best: IndexedItem | null = null;
    let score = 0;
    for (const item of seen) {
      const s = similarity(key, item.key);
      if (s > score) {
        score = s;
        best = item;
      }
    }
    return best ? { item: best, score } : null;
  }

  top(key: string, n: number): IndexedItem[] {
    const seen = new Set<IndexedItem>();
    for (const tok of new Set(key.split(' '))) {
      for (const item of this.byToken.get(tok) ?? []) seen.add(item);
    }
    return [...seen]
      .map((item) => ({ item, s: similarity(key, item.key) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, n)
      .map((x) => x.item);
  }
}

// ---------------------------------------------------------------------------

interface KeyStats {
  displayName: string; // most frequent raw parsed name for this key
  count: number;
  nameCounts: Map<string, number>;
  dims: Map<UnitDimension, number>;
}

const AUTO = 0.85;

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function dominantDim(stats: KeyStats): UnitDimension {
  let best: UnitDimension = 'COUNT';
  let n = -1;
  for (const [dim, c] of stats.dims) {
    if (c > n) {
      n = c;
      best = dim;
    }
  }
  return best;
}

const llmBatchSchema = z.array(
  z.object({
    name: z.string(),
    canonical: z.string(),
    sameAsCandidate: z.string().nullable(),
  }),
);

async function main() {
  const args = parseArgs();
  const household = await prisma.household.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  console.log(`Linking ingredients for household ${household.id}`);
  console.log(
    `llm=${args.llm ? `${args.llmModel} @ ${args.llmBaseUrl} (max ${args.llmMax} keys)` : 'off'} ` +
      `create-threshold=${args.createThreshold} dry-run=${args.dryRun}`,
  );

  // ---- Pass 1: aggregate unlinked rows by normalized name ----
  const keys = new Map<string, KeyStats>();
  let scanned = 0;
  let cursor: string | undefined;
  const t0 = Date.now();
  for (;;) {
    const rows = await prisma.recipeIngredient.findMany({
      where: { canonicalItemId: null, freeText: { not: null } },
      select: { id: true, freeText: true, unit: true },
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: 50_000,
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1]!.id;
    scanned += rows.length;
    for (const row of rows) {
      const parsed = parseIngredientLine(row.freeText!);
      const key = normalizeName(parsed.name);
      if (!key || key.length < 2) continue;
      let stats = keys.get(key);
      if (!stats) {
        stats = { displayName: parsed.name, count: 0, nameCounts: new Map(), dims: new Map() };
        keys.set(key, stats);
      }
      stats.count++;
      stats.nameCounts.set(parsed.name, (stats.nameCounts.get(parsed.name) ?? 0) + 1);
      const dim = dimensionOf(row.unit as Unit);
      stats.dims.set(dim, (stats.dims.get(dim) ?? 0) + 1);
    }
    process.stdout.write(`\rpass1: scanned ${scanned} rows, ${keys.size} distinct keys`);
  }
  console.log(`\npass1 done in ${Math.round((Date.now() - t0) / 1000)}s`);

  // Pick the most common surface form as the display name.
  for (const stats of keys.values()) {
    let bestName = stats.displayName;
    let n = 0;
    for (const [name, c] of stats.nameCounts) {
      if (c > n) {
        n = c;
        bestName = name;
      }
    }
    stats.displayName = bestName;
  }

  // ---- Load existing canonical items into the index ----
  const index = new ItemIndex();
  for (const item of await prisma.canonicalItem.findMany({ where: { householdId: household.id } })) {
    index.add({ id: item.id, name: item.name, key: item.normKey || buildNormKey(item.name, item.brand) });
  }

  // ---- Resolve keys, most frequent first ----
  const sorted = [...keys.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, args.limitKeys === Infinity ? undefined : args.limitKeys);

  const keyToItem = new Map<string, string>(); // key -> canonicalItemId
  const toCreate: { id: string; name: string; key: string; dim: UnitDimension; count: number }[] = [];
  const llmQueue: { key: string; stats: KeyStats }[] = [];
  let linkedExact = 0;
  let linkedFuzzy = 0;
  let skipped = 0;

  const createFor = (key: string, name: string, dim: UnitDimension, count: number) => {
    const id = randomUUID();
    toCreate.push({ id, name, key, dim, count });
    index.add({ id, name, key });
    keyToItem.set(key, id);
  };

  for (const [key, stats] of sorted) {
    const exact = index.exact(key);
    if (exact) {
      keyToItem.set(key, exact.id);
      linkedExact++;
      continue;
    }
    const fuzzy = index.best(key);
    if (fuzzy && fuzzy.score >= AUTO) {
      keyToItem.set(key, fuzzy.item.id);
      linkedFuzzy++;
      continue;
    }
    if (args.llm && llmQueue.length < args.llmMax && stats.count >= args.createThreshold) {
      llmQueue.push({ key, stats });
    } else if (stats.count >= args.createThreshold) {
      createFor(key, titleCase(stats.displayName), dominantDim(stats), stats.count);
    } else {
      skipped++;
    }
  }

  // ---- LLM stage: clean names + merge synonyms (batched) ----
  let llmCleaned = 0;
  let llmMerged = 0;
  let llmFailed = 0;
  if (args.llm && llmQueue.length && !args.dryRun) {
    console.log(`LLM stage: ${llmQueue.length} keys via ${args.llmModel}`);
    const BATCH = 40;
    for (let i = 0; i < llmQueue.length; i += BATCH) {
      const batch = llmQueue.slice(i, i + BATCH);
      const payload = batch.map(({ key, stats }) => ({
        name: stats.displayName,
        candidates: index.top(key, 3).map((c) => c.name),
      }));
      try {
        const raw = await chatJson({
          baseUrl: args.llmBaseUrl,
          model: args.llmModel,
          system:
            'You canonicalize grocery ingredient names for a pantry database. ' +
            'For each input return: "canonical" — the concise generic grocery item you would buy ' +
            '(singular, no quantities, no preparation words like chopped/melted/fresh); and ' +
            '"sameAsCandidate" — EXACTLY one of the provided candidate strings if the input is the ' +
            'same purchasable item as that candidate, else null. ' +
            'Respond with JSON: {"results": [{"name", "canonical", "sameAsCandidate"}]} in input order.',
          prompt: JSON.stringify(payload),
          maxTokens: 3000,
        });
        const obj = raw as { results?: unknown };
        const results = llmBatchSchema.parse(Array.isArray(raw) ? raw : obj.results);
        for (let j = 0; j < batch.length; j++) {
          const { key, stats } = batch[j]!;
          const r = results[j];
          if (!r) {
            createFor(key, titleCase(stats.displayName), dominantDim(stats), stats.count);
            continue;
          }
          const merged = r.sameAsCandidate
            ? index.top(key, 3).find((c) => c.name.toLowerCase() === r.sameAsCandidate!.toLowerCase())
            : undefined;
          if (merged) {
            keyToItem.set(key, merged.id);
            llmMerged++;
          } else {
            const cleanName = r.canonical.trim() ? titleCase(r.canonical.trim()) : titleCase(stats.displayName);
            const cleanKey = buildNormKey(cleanName);
            // The cleaned name may itself collide with an existing item — reuse it if so.
            const existing = index.exact(cleanKey);
            if (existing) {
              keyToItem.set(key, existing.id);
              llmMerged++;
            } else {
              createFor(key, cleanName, dominantDim(stats), stats.count);
              llmCleaned++;
            }
          }
        }
      } catch (err) {
        llmFailed += batch.length;
        // LLM batch failed — fall back to deterministic creation for these keys.
        for (const { key, stats } of batch) {
          if (!keyToItem.has(key)) {
            createFor(key, titleCase(stats.displayName), dominantDim(stats), stats.count);
          }
        }
        console.warn(`\nLLM batch failed (${err instanceof Error ? err.message : err}); used deterministic fallback`);
      }
      process.stdout.write(`\rllm: ${Math.min(i + BATCH, llmQueue.length)}/${llmQueue.length}`);
    }
    console.log();
  }

  console.log(
    `resolved: exact=${linkedExact} fuzzy=${linkedFuzzy} llm-merged=${llmMerged} ` +
      `to-create=${toCreate.length} (llm-cleaned=${llmCleaned}, llm-failed=${llmFailed}) below-threshold=${skipped}`,
  );

  if (args.dryRun) {
    console.log('\nDRY RUN — top 40 planned creations:');
    for (const c of toCreate.slice(0, 40)) console.log(`  ${c.count}× ${c.name} [${c.dim}]`);
    console.log(`\nwould link ${keyToItem.size} keys; no writes performed`);
    return;
  }

  // ---- Create new canonical items ----
  if (toCreate.length) {
    await prisma.canonicalItem.createMany({
      data: toCreate.map((c) => ({
        id: c.id,
        householdId: household.id,
        name: c.name.slice(0, 200),
        normKey: c.key,
        baseUnit: BASE_UNIT[c.dim],
        baseDimension: c.dim,
      })),
      skipDuplicates: true,
    });
    console.log(`created ${toCreate.length} canonical items`);
  }

  // ---- Pass 2: write links back in bulk ----
  let linkedRows = 0;
  cursor = undefined;
  const buffers = new Map<string, string[]>(); // itemId -> row ids
  const flush = async (itemId: string, ids: string[]) => {
    await prisma.recipeIngredient.updateMany({
      where: { id: { in: ids } },
      data: { canonicalItemId: itemId },
    });
    linkedRows += ids.length;
  };
  for (;;) {
    const rows: { id: string; freeText: string | null }[] =
      await prisma.recipeIngredient.findMany({
        where: { canonicalItemId: null, freeText: { not: null } },
        select: { id: true, freeText: true },
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: 50_000,
      });
    if (!rows.length) break;
    cursor = rows[rows.length - 1]!.id;
    for (const row of rows) {
      const key = normalizeName(parseIngredientLine(row.freeText!).name);
      const itemId = keyToItem.get(key);
      if (!itemId) continue;
      const buf = buffers.get(itemId);
      if (buf) {
        buf.push(row.id);
        if (buf.length >= 5000) {
          await flush(itemId, buf);
          buffers.set(itemId, []);
        }
      } else {
        buffers.set(itemId, [row.id]);
      }
    }
    process.stdout.write(`\rpass2: linked ~${linkedRows} rows`);
  }
  for (const [itemId, ids] of buffers) {
    if (ids.length) await flush(itemId, ids);
  }

  console.log(`\nDONE — linked ${linkedRows} ingredient rows across ${keyToItem.size} keys`);
  const remaining = await prisma.recipeIngredient.count({
    where: { canonicalItemId: null, freeText: { not: null } },
  });
  console.log(`unlinked rows remaining: ${remaining} (below-threshold long tail; re-run with a lower --create-threshold to link more)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
