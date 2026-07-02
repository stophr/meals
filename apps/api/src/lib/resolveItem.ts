import { prisma } from '@meals/db';
import { rootIngredientName, buildNormKey } from '@meals/core';

// Resolve a raw ingredient/product name to a canonical item via the alias index, falling back
// to the deterministic root name, and only creating a new item when nothing matches. This is
// what keeps "Pinch Of Sugar" / "Caster Sugar" from spawning fresh variants — they resolve to
// the existing "Sugar" and get recorded as aliases.

const normAlias = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export interface ResolvedItem {
  id: string;
  created: boolean;
}

export async function resolveCanonicalItem(
  householdId: string,
  rawName: string,
  extra?: { category?: string; baseUnit?: string; baseDimension?: string },
): Promise<ResolvedItem> {
  const raw = normAlias(rawName);

  // 1. Direct alias hit.
  const alias = await prisma.ingredientAlias.findUnique({
    where: { householdId_rawName: { householdId, rawName: raw } },
  });
  if (alias) return { id: alias.canonicalItemId, created: false };

  // 2. Deterministic root — alias hit or an existing item already named the root.
  const root = rootIngredientName(rawName);
  const rootKey = normAlias(root);
  const rootAlias =
    rootKey === raw
      ? null
      : await prisma.ingredientAlias.findUnique({
          where: { householdId_rawName: { householdId, rawName: rootKey } },
        });
  const existing =
    rootAlias
      ? { id: rootAlias.canonicalItemId }
      : await prisma.canonicalItem.findFirst({
          where: { householdId, name: { equals: root, mode: 'insensitive' } },
          select: { id: true },
        });

  if (existing) {
    await prisma.ingredientAlias.upsert({
      where: { householdId_rawName: { householdId, rawName: raw } },
      create: { householdId, rawName: raw, canonicalItemId: existing.id },
      update: { canonicalItemId: existing.id },
    });
    return { id: existing.id, created: false };
  }

  // 3. Nothing matched — create the clean root item and alias both names to it.
  const created = await prisma.canonicalItem.create({
    data: {
      householdId,
      name: root,
      category: extra?.category,
      baseUnit: extra?.baseUnit as never,
      baseDimension: extra?.baseDimension as never,
      normKey: buildNormKey(root),
    },
  });
  for (const rn of new Set([raw, rootKey])) {
    await prisma.ingredientAlias.upsert({
      where: { householdId_rawName: { householdId, rawName: rn } },
      create: { householdId, rawName: rn, canonicalItemId: created.id },
      update: { canonicalItemId: created.id },
    });
  }
  return { id: created.id, created: true };
}
