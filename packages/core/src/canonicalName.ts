// Deterministic "root ingredient" normalizer: strip quantities, measures, and prep/condition
// words that leak into ingredient names, then map common synonyms to the US grocery name a
// shopper actually buys. SAFE BY DESIGN — it only removes a whitelist of noise words, so two
// names collapse to the same root only when they truly differ by noise. "Sugar Snap Peas"
// keeps its "snap peas" (not noise) and never collapses into "Sugar".

// Measure/quantity words that show up as leaked prefixes ("Pinch Of Sugar", "Tblsp Butter").
const MEASURE = new Set([
  'pinch', 'pinches', 'dash', 'dashes', 'splash', 'splashes', 'handful', 'handfuls', 'handfulls',
  'knob', 'knobs', 'pony', 'shot', 'shots', 'segment', 'segments', 'glass', 'glasses', 'drop', 'drops',
  'tbsp', 'tbsps', 'tblsp', 'tblsps', 'tbs', 'tablespoon', 'tablespoons',
  'tsp', 'tsps', 'teaspoon', 'teaspoons', 'cup', 'cups', 'oz', 'ounce', 'ounces',
  'lb', 'lbs', 'pound', 'pounds', 'g', 'gr', 'gram', 'grams', 'kg', 'mg',
  'ml', 'l', 'liter', 'liters', 'litre', 'litres', 'quart', 'pint', 'gallon',
  'clove', 'cloves', 'can', 'cans', 'jar', 'jars', 'tin', 'tins',
  'package', 'packages', 'packet', 'packets', 'pkg', 'pack', 'stick', 'sticks',
  'bunch', 'bunches', 'sprig', 'sprigs', 'strip', 'strips', 'fillet', 'fillets',
]);

// Preparation / condition words — never product-defining, safe to drop.
const PREP = new Set([
  'packed', 'chopped', 'minced', 'diced', 'sliced', 'grated', 'shredded',
  'crushed', 'mashed', 'cubed', 'julienned', 'quartered', 'halved', 'pitted',
  'seeded', 'cored', 'peeled', 'rinsed', 'drained', 'trimmed', 'deveined',
  'fresh', 'freshly', 'softened', 'melted', 'beaten', 'sifted', 'toasted',
  'boneless', 'skinless', 'large', 'small', 'medium', 'ripe', 'unripe',
  'warm', 'cold', 'chilled', 'finely', 'coarsely', 'roughly', 'thinly', 'thickly',
  'extra', 'optional', 'assorted', 'mixed', 'good', 'quality', 'nice',
  'sprinkling', 'sprinkle', 'drizzle', 'drizzling', 'generous', 'scant', 'heaped', 'heaping',
]);

// Connectives dropped anywhere.
const STOP = new Set(['of', 'a', 'an', 'the', 'some', 'to', 'for', 'into', 'plus', 'or', 'and']);

// Whole-phrase synonyms -> the buyable US grocery name.
const PHRASE_SYNONYMS: Record<string, string> = {
  'confectioners sugar': 'Powdered Sugar',
  'confectioner sugar': 'Powdered Sugar',
  'icing sugar': 'Powdered Sugar',
  'caster sugar': 'Sugar',
  'castor sugar': 'Sugar',
  'superfine sugar': 'Sugar',
  'granulated sugar': 'Sugar',
  'white sugar': 'Sugar',
  'minced beef': 'Ground Beef',
  'beef mince': 'Ground Beef',
  'minced pork': 'Ground Pork',
  'plain flour': 'All-Purpose Flour',
  'all purpose flour': 'All-Purpose Flour',
  'spring onion': 'Green Onion',
  'spring onions': 'Green Onion',
  'scallion': 'Green Onion',
  'scallions': 'Green Onion',
  aubergine: 'Eggplant',
  courgette: 'Zucchini',
  courgettes: 'Zucchini',
  capsicum: 'Bell Pepper',
  rocket: 'Arugula',
  prawn: 'Shrimp',
  prawns: 'Shrimp',
  coriander: 'Cilantro',
  passata: 'Tomato Sauce',
};

function titleCase(s: string): string {
  return s
    .split(' ')
    .filter(Boolean)
    .map((w) => w.replace(/(^|-)([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase()))
    .join(' ');
}

/** Normalize a messy ingredient name to the buyable "root" product name. */
export function rootIngredientName(raw: string): string {
  const cleanedRaw = raw
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // drop parentheticals
    .replace(/[^a-z0-9\s-]/g, ' ') // punctuation -> space (hyphens kept: "sugar-free")
    .replace(/\b\d+([./]\d+)?\b/g, ' ') // bare numbers / fractions
    .replace(/[½¼¾⅓⅔⅛]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Drop leaked quantity words first, but KEEP prep words so synonym phrases that include
  // them ("minced beef" -> Ground Beef) still match.
  const measured = cleanedRaw
    .split(' ')
    .filter((t) => t && !MEASURE.has(t) && !STOP.has(t))
    .join(' ')
    .trim();
  if (PHRASE_SYNONYMS[measured]) return PHRASE_SYNONYMS[measured]!;

  // Now drop prep/condition words too.
  const tokens = measured.split(' ').filter((t) => t && !PREP.has(t));
  const cleaned = tokens.join(' ').trim();
  if (!cleaned) return titleCase(measured) || titleCase(raw.trim()) || raw.trim();

  if (PHRASE_SYNONYMS[cleaned]) return PHRASE_SYNONYMS[cleaned]!;
  if (tokens.length === 1 && PHRASE_SYNONYMS[tokens[0]!]) return PHRASE_SYNONYMS[tokens[0]!]!;
  return titleCase(cleaned);
}

/** Stable key for grouping/aliasing (lowercased root). */
export function ingredientKey(raw: string): string {
  return rootIngredientName(raw).toLowerCase();
}
