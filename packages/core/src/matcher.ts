// Item matching: turn a raw store/receipt line ("GV MLK 2% 1G") into a ProviderProduct.
//
// MVP ladder (see plan §5): callers try UPC/PLU exact, then a persisted ProductAlias, then
// fall back to the fuzzy text scoring here. Postgres pg_trgm + embeddings are Phase 2; this
// module keeps the normalization + scoring pure and testable so the api can swap the backend.

const UNIT_TOKENS = new Set([
  'g', 'kg', 'mg', 'oz', 'lb', 'lbs', 'ml', 'l', 'floz', 'ct', 'pk', 'pack',
  'gal', 'gallon', 'qt', 'pt', 'ea', 'each', 'dz', 'dozen', 'cup', 'cups',
  'tbsp', 'tsp', 'can', 'cans', 'bottle', 'btl',
]);

/**
 * Lowercase; drop parentheticals, pack/size tokens, and standalone numbers; keep percentages
 * ("2%"); naive singularize; sort tokens so word order doesn't affect matching. The sorted,
 * cleaned token string is the comparison key.
 */
export function normalizeName(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/\([^)]*\)/g, ' ');
  const rawTokens = cleaned.split(/[^a-z0-9%.]+/).filter(Boolean);

  const out: string[] = [];
  for (const token of rawTokens) {
    let t = token.replace(/\.+$/, ''); // trailing dots
    if (!t) continue;
    if (/^\d+(\.\d+)?%$/.test(t)) {
      out.push(t); // keep percentages like "2%"
      continue;
    }
    if (/^\d+(\.\d+)?$/.test(t)) continue; // pure number
    // number glued to a unit, e.g. "1gal", "500ml"
    const glued = t.match(/^\d+(?:\.\d+)?([a-z]+)$/);
    if (glued && UNIT_TOKENS.has(glued[1]!)) continue;
    if (UNIT_TOKENS.has(t)) continue;
    if (t.length > 3 && t.endsWith('s')) t = t.slice(0, -1); // naive singularize
    out.push(t);
  }

  return out.sort().join(' ').trim();
}

/** Dedup key for a CanonicalItem. */
export function buildNormKey(name: string, brand?: string | null): string {
  return normalizeName([brand ?? '', name].join(' ')).trim();
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/\s+/g, '');
  for (let i = 0; i < t.length - 1; i++) {
    const bg = t.slice(i, i + 2);
    m.set(bg, (m.get(bg) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice similarity of two strings' character bigrams, in [0,1]. */
export function similarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const A = bigrams(na);
  const B = bigrams(nb);
  let overlap = 0;
  for (const [bg, count] of A) {
    const other = B.get(bg);
    if (other) overlap += Math.min(count, other);
  }
  const total = [...A.values()].reduce((s, n) => s + n, 0) + [...B.values()].reduce((s, n) => s + n, 0);
  return (2 * overlap) / total;
}

export type MatchDecision = 'auto' | 'review' | 'new';

export interface MatchCandidate {
  productId: string;
  text: string;
}

export interface MatchResult {
  productId: string | null;
  score: number;
  decision: MatchDecision;
}

export interface MatchThresholds {
  auto: number; // >= this -> auto-accept
  review: number; // >= this (and < auto) -> queue for human review; below -> propose new
}

export const DEFAULT_THRESHOLDS: MatchThresholds = { auto: 0.85, review: 0.55 };

/** Best fuzzy match for a raw line among candidate products. */
export function matchLine(
  rawName: string,
  candidates: MatchCandidate[],
  thresholds: MatchThresholds = DEFAULT_THRESHOLDS,
): MatchResult {
  let best: MatchCandidate | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const s = similarity(rawName, c.text);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }

  if (best && bestScore >= thresholds.auto) {
    return { productId: best.productId, score: bestScore, decision: 'auto' };
  }
  if (best && bestScore >= thresholds.review) {
    return { productId: best.productId, score: bestScore, decision: 'review' };
  }
  return { productId: null, score: bestScore, decision: 'new' };
}
