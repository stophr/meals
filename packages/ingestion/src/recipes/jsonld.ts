import type { NormalizedRecipe } from './types.js';

// Recipe import from any web page embedding schema.org/Recipe JSON-LD — which is nearly every
// recipe site (they do it for Google rich results). Carries ingredients, ratings, cuisine,
// category, durations, and images. We fetch the page, pull <script type="application/ld+json">
// blocks, find the Recipe node, and normalize.

type JsonValue = unknown;
type JsonObject = Record<string, JsonValue>;

function isObject(v: JsonValue): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeMatches(node: JsonObject, type: string): boolean {
  const t = node['@type'];
  if (typeof t === 'string') return t.toLowerCase() === type.toLowerCase();
  if (Array.isArray(t)) return t.some((x) => typeof x === 'string' && x.toLowerCase() === type.toLowerCase());
  return false;
}

/** Depth-first hunt for a Recipe node across top-level arrays and @graph containers. */
export function findRecipeNode(json: JsonValue): JsonObject | null {
  if (Array.isArray(json)) {
    for (const item of json) {
      const found = findRecipeNode(item);
      if (found) return found;
    }
    return null;
  }
  if (!isObject(json)) return null;
  if (typeMatches(json, 'Recipe')) return json;
  if (Array.isArray(json['@graph'])) return findRecipeNode(json['@graph']);
  return null;
}

/** "PT1H30M" -> 90. Returns undefined for absent/garbage. */
export function parseIsoDurationMinutes(v: JsonValue): number | undefined {
  if (typeof v !== 'string') return undefined;
  const m = v.match(/^-?P(?:(\d+(?:\.\d+)?)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return undefined;
  const mins =
    (m[1] ? Number(m[1]) * 1440 : 0) +
    (m[2] ? Number(m[2]) * 60 : 0) +
    (m[3] ? Number(m[3]) : 0) +
    (m[4] ? Number(m[4]) / 60 : 0);
  return Math.round(mins);
}

function firstString(v: JsonValue): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = firstString(item);
      if (s) return s;
    }
    return undefined;
  }
  if (isObject(v)) {
    // ImageObject{url}, Person{name}, etc.
    return firstString(v['url'] ?? v['name']);
  }
  return undefined;
}

function stringList(v: JsonValue): string[] {
  if (typeof v === 'string') {
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(v)) {
    return v.flatMap((item) => (typeof item === 'string' ? [item.trim()] : stringList(item))).filter(Boolean);
  }
  return [];
}

/** recipeInstructions: string | string[] | HowToStep[] | HowToSection[] -> flat numbered text. */
function instructionsText(v: JsonValue): string | undefined {
  const steps: string[] = [];
  function walk(node: JsonValue) {
    if (typeof node === 'string') {
      const t = node.trim();
      if (t) steps.push(t);
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (isObject(node)) {
      if (Array.isArray(node['itemListElement'])) walk(node['itemListElement']);
      else if (typeof node['text'] === 'string') steps.push(node['text'].trim());
      else if (typeof node['name'] === 'string') steps.push(node['name'].trim());
    }
  }
  walk(v);
  if (!steps.length) return undefined;
  return steps.length === 1 ? steps[0] : steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

function parseServings(v: JsonValue): number | undefined {
  if (typeof v === 'number' && v > 0) return Math.round(v);
  const s = firstString(v);
  const m = s?.match(/\d+/);
  return m ? Number(m[0]) : undefined;
}

/** Pure mapper: JSON-LD Recipe node -> NormalizedRecipe. */
export function mapJsonLdRecipe(node: JsonObject, sourceUrl: string): NormalizedRecipe {
  const rating = isObject(node['aggregateRating']) ? node['aggregateRating'] : undefined;
  const ratingValue = rating ? Number(firstString(rating['ratingValue']) ?? rating['ratingValue']) : NaN;
  const ratingCount = rating
    ? Number(firstString(rating['ratingCount']) ?? rating['ratingCount'] ?? rating['reviewCount']) ||
      undefined
    : undefined;

  const prep = parseIsoDurationMinutes(node['totalTime']) ??
    ((parseIsoDurationMinutes(node['prepTime']) ?? 0) + (parseIsoDurationMinutes(node['cookTime']) ?? 0) || undefined);

  let host = 'web';
  try {
    host = new URL(sourceUrl).hostname.replace(/^www\./, '');
  } catch {
    /* keep default */
  }

  return {
    name: firstString(node['name']) ?? 'Untitled recipe',
    sourceName: host,
    sourceUrl,
    imageUrl: firstString(node['image']),
    servings: parseServings(node['recipeYield']),
    prepMinutes: prep,
    instructions: instructionsText(node['recipeInstructions']),
    cuisine: stringList(node['recipeCuisine'])[0],
    category: stringList(node['recipeCategory'])[0],
    tags: stringList(node['keywords']).slice(0, 12),
    externalRating: Number.isFinite(ratingValue) ? Math.min(5, Math.max(0, ratingValue)) : undefined,
    externalRatingCount: ratingCount,
    ingredientLines: stringList(node['recipeIngredient'] ?? node['ingredients']),
  };
}

/** Extract every JSON-LD block from an HTML document. */
export function extractJsonLdBlocks(html: string): JsonValue[] {
  const blocks: JsonValue[] = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      blocks.push(JSON.parse(m[1]!.trim()));
    } catch {
      /* skip malformed blocks */
    }
  }
  return blocks;
}

/**
 * Fetch a page and return BOTH the raw schema.org Recipe JSON-LD node and the parsed recipe.
 * Storing the raw node lets us re-parse locally (e.g. after fixing a parser bug) without
 * re-crawling. Throws if no Recipe node is found.
 */
export async function fetchRecipeRaw(url: string): Promise<{ node: JsonObject; normalized: NormalizedRecipe }> {
  const res = await fetch(url, {
    headers: {
      // Recipe sites gate on UA; present as a regular browser.
      'user-agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
  const html = await res.text();

  for (const block of extractJsonLdBlocks(html)) {
    const node = findRecipeNode(block);
    if (node) {
      const normalized = mapJsonLdRecipe(node, url);
      if (normalized.ingredientLines.length) return { node, normalized };
    }
  }
  throw new Error('No schema.org Recipe JSON-LD found on that page');
}

/** Re-parse a previously-stored raw JSON-LD node — no network. */
export function parseRecipeNode(node: unknown, sourceUrl: string): NormalizedRecipe {
  return mapJsonLdRecipe(node as JsonObject, sourceUrl);
}

/** Fetch a page and normalize its schema.org Recipe. Throws if none is found. */
export async function importRecipeFromUrl(url: string): Promise<NormalizedRecipe> {
  return (await fetchRecipeRaw(url)).normalized;
}
