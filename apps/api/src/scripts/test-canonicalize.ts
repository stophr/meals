// Dry A/B harness: run the canonicalizer over items matching a name filter with a given
// model and print name -> root/category, so we can compare models before consolidating.
//
// Usage: pnpm --filter @meals/api exec tsx src/scripts/test-canonicalize.ts \
//   --filter sugar --llm-model qwen2.5:7b [--llm-base-url http://localhost:11434/v1]

import { prisma } from '@meals/db';
import { canonicalizeNames } from '../lib/canonicalize.js';

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const filter = arg('--filter') ?? '';
  const model = arg('--llm-model') ?? 'qwen2.5:7b';
  const baseUrl = arg('--llm-base-url') ?? 'http://localhost:11434/v1';

  const items = await prisma.canonicalItem.findMany({
    where: { name: { contains: filter, mode: 'insensitive' } },
    select: { id: true, name: true, category: true },
    orderBy: { name: 'asc' },
  });
  console.log(`\n=== model ${model} on ${items.length} item(s) matching "${filter}" ===`);
  const t0 = Date.now();
  const map = await canonicalizeNames(items, { baseUrl, model });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const byRoot = new Map<string, string[]>();
  for (const it of items) {
    const m = map.get(it.id);
    const root = m ? `${m.root}  [${m.category}]` : '(no mapping)';
    const list = byRoot.get(root) ?? [];
    list.push(it.name);
    byRoot.set(root, list);
  }
  for (const [root, names] of [...byRoot.entries()].sort()) {
    console.log(`\n  ${root}`);
    for (const n of names.sort()) console.log(`      ${n}`);
  }
  console.log(`\n  (${secs}s, ${map.size}/${items.length} mapped)\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
