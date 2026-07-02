import type { Unit } from '@meals/shared';

// Free-text ingredient line parsing ("2 cups all-purpose flour" -> qty/unit/name) used by
// recipe ingestion. Deterministic and forgiving: anything unparseable falls back to
// quantity=null so callers can default (1 EACH) while keeping the original freeText.

const UNIT_ALIASES: Record<string, Unit> = {
  cup: 'CUP', cups: 'CUP', c: 'CUP',
  tablespoon: 'TBSP', tablespoons: 'TBSP', tbsp: 'TBSP', tbsps: 'TBSP', tbs: 'TBSP',
  teaspoon: 'TSP', teaspoons: 'TSP', tsp: 'TSP', tsps: 'TSP',
  gram: 'G', grams: 'G', g: 'G', gr: 'G',
  kilogram: 'KG', kilograms: 'KG', kg: 'KG', kgs: 'KG',
  milligram: 'MG', milligrams: 'MG', mg: 'MG',
  milliliter: 'ML', milliliters: 'ML', millilitre: 'ML', millilitres: 'ML', ml: 'ML',
  liter: 'L', liters: 'L', litre: 'L', litres: 'L', l: 'L',
  ounce: 'OZ', ounces: 'OZ', oz: 'OZ',
  pound: 'LB', pounds: 'LB', lb: 'LB', lbs: 'LB',
  can: 'CAN', cans: 'CAN', tin: 'CAN', tins: 'CAN',
  bottle: 'BOTTLE', bottles: 'BOTTLE',
  bunch: 'BUNCH', bunches: 'BUNCH',
  pack: 'PACK', packs: 'PACK', package: 'PACK', packages: 'PACK', packet: 'PACK', packets: 'PACK',
  each: 'EACH', whole: 'EACH', piece: 'EACH', pieces: 'EACH',
};

const UNICODE_FRACTIONS: Record<string, number> = {
  '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
  '⅙': 1 / 6, '⅚': 5 / 6, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};

const OPTIONAL_MARKERS = /\b(to taste|optional|for serving|for garnish|garnish|as needed|if desired)\b/i;

export interface ParsedIngredient {
  quantity: number | null;
  unit: Unit | null;
  /** Cleaned item name with quantity/unit/descriptors stripped. */
  name: string;
  optional: boolean;
}

/** "1 1/2", "3/4", "1.5", "½", "1½" -> number. Returns [value, charsConsumed] or null. */
function parseLeadingQuantity(s: string): [number, number] | null {
  let rest = s;
  let total = 0;
  let consumed = 0;
  let matched = false;

  for (;;) {
    const m = rest.match(/^\s*(?:(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?|([¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]))/);
    if (!m) break;
    if (m[3]) {
      total += UNICODE_FRACTIONS[m[3]]!;
    } else if (m[2]) {
      total += Number(m[1]) / Number(m[2]); // "3/4"
    } else {
      total += Number(m[1]);
    }
    consumed += m[0].length;
    rest = s.slice(consumed);
    matched = true;
    // Allow one follow-up fraction ("1 1/2", "1½") but stop after two components.
    if (!/^\s*(?:\d+\s*\/\s*\d+|[¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])/.test(rest)) break;
  }

  return matched && total > 0 ? [total, consumed] : null;
}

export function parseIngredientLine(raw: string): ParsedIngredient {
  const optional = OPTIONAL_MARKERS.test(raw);
  let text = raw
    .replace(/\([^)]*\)/g, ' ') // drop parentheticals ("(sifted)")
    .replace(OPTIONAL_MARKERS, ' ')
    .replace(/[,;].*$/, ' ') // drop trailing clauses (", finely chopped")
    .replace(/\s+/g, ' ')
    .trim();

  let quantity: number | null = null;
  const q = parseLeadingQuantity(text);
  if (q) {
    quantity = Math.round(q[0] * 1000) / 1000;
    text = text.slice(q[1]).trim();
    // Ranges ("1-2 cups", "1 to 2 cups"): keep the lower bound, drop the upper.
    const range = text.match(/^(?:-|–|to)\s*\d+(?:\s+\d+\s*\/\s*\d+|\.\d+|\s*\/\s*\d+)?\s*/);
    if (range) text = text.slice(range[0].length).trim();
  }

  let unit: Unit | null = null;
  const unitMatch = text.match(/^(fl\s?oz|[a-zA-Z]+)\.?\s+/);
  if (unitMatch) {
    const key = unitMatch[1]!.toLowerCase().replace(/\s/g, '');
    const mapped = key === 'floz' ? 'FLOZ' : UNIT_ALIASES[key];
    if (mapped) {
      unit = mapped;
      text = text.slice(unitMatch[0].length).trim();
    }
  }

  const name = text
    .replace(/^of\s+/i, '') // "2 cups of flour"
    .replace(/\s+/g, ' ')
    .trim();

  return { quantity, unit, name: name || raw.trim(), optional };
}

/**
 * Complexity heuristic for catalog filtering. Deliberately simple; can be replaced by a
 * model-scored value later without a schema change.
 */
export function complexityOf(
  ingredientCount: number,
  prepMinutes?: number | null,
): 'EASY' | 'MEDIUM' | 'HARD' {
  const prep = prepMinutes ?? 30;
  if (ingredientCount >= 12 || prep >= 75) return 'HARD';
  if (ingredientCount <= 6 && prep <= 25) return 'EASY';
  return 'MEDIUM';
}
