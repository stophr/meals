import { chatJson } from '@meals/ingestion';

// Map messy recipe-ingredient names to the ACTUAL grocery product a shopper buys, using a
// local LLM. "Pinch Of Sugar" / "Tblsp Caster Sugar" -> "Sugar"; "Packed Dark Brown Sugar"
// -> "Brown Sugar"; but "Sugar Snap Peas" (a vegetable) and "Sugar Substitute" stay distinct.

export const AISLES = [
  'Produce',
  'Meat & Seafood',
  'Dairy & Eggs',
  'Bakery & Baking',
  'Grains & Pasta',
  'Canned & Jarred',
  'Spices & Seasoning',
  'Condiments & Sauces',
  'Frozen',
  'Beverages',
  'Snacks',
  'Other',
] as const;

export interface CanonMap {
  root: string;
  category: string;
}

const SYSTEM = `You normalize messy recipe-ingredient names to the ACTUAL grocery product a shopper buys.

Rules:
- Strip quantity/measure words that leaked into the name: pinch, dash, splash, handful, tblsp, tbsp, tsp, cup, oz, lb, gram, kg, ml, clove, can, jar, package, packet, stick, bunch, head, slice, piece, sprig.
- Strip preparation/state adjectives: packed, chopped, minced, diced, sliced, grated, shredded, ground, fresh, frozen, dried, cooked, raw, melted, softened, beaten, sifted, peeled, boneless, skinless, large, small, medium, ripe, warm, cold, hot, extra, fine, coarse.
- Normalize regional/synonym names to the common US grocery name: caster/superfine sugar -> Sugar; icing/confectioners sugar -> Powdered Sugar; minced beef -> Ground Beef; aubergine -> Eggplant; courgette -> Zucchini; coriander (leaf) -> Cilantro; spring onion / scallion -> Green Onion; prawns -> Shrimp; plain flour -> All-Purpose Flour.
- Keep genuinely DIFFERENT products separate — never merge things that only share a word. "Sugar Snap Peas" is a vegetable, NOT sugar. "Sugar Substitute" and "Sugar-Free ___" are NOT sugar. "Brown Sugar", "Powdered Sugar", "Demerara Sugar" are each distinct from plain "Sugar". "Garlic Powder" is distinct from "Garlic". "Chicken Broth" is distinct from "Chicken".
- "root" is a clean, buyable product name in Title Case, singular where natural.
- "category" MUST be EXACTLY one of: Produce | Meat & Seafood | Dairy & Eggs | Bakery & Baking | Grains & Pasta | Canned & Jarred | Spices & Seasoning | Condiments & Sauces | Frozen | Beverages | Snacks | Other.

Worked examples:
{"results":[
{"id":"a","root":"Sugar","category":"Bakery & Baking"},
{"id":"b","root":"Brown Sugar","category":"Bakery & Baking"},
{"id":"c","root":"Powdered Sugar","category":"Bakery & Baking"},
{"id":"d","root":"Sugar Snap Peas","category":"Produce"},
{"id":"e","root":"Ground Beef","category":"Meat & Seafood"},
{"id":"f","root":"Green Onion","category":"Produce"}
]}
(inputs were: a="Pinch Of Sugar", b="Packed Dark Brown Sugar", c="Confectioners Sugar", d="Sugar Snap Peas", e="Minced Beef", f="Spring Onions")

Echo every input id. Respond ONLY with JSON {"results":[{"id","root","category"}]}.`;

/** LLM-normalize a batch of {id,name} to {root,category}. Returns a Map keyed by id. */
export async function canonicalizeNames(
  items: { id: string; name: string }[],
  opts: { baseUrl: string; model: string; batch?: number },
): Promise<Map<string, CanonMap>> {
  const out = new Map<string, CanonMap>();
  const size = opts.batch ?? 30;
  const aisleSet = new Set<string>(AISLES);

  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const raw = await chatJson({
      baseUrl: opts.baseUrl,
      model: opts.model,
      system: SYSTEM,
      prompt: JSON.stringify(batch.map((b) => ({ id: b.id, name: b.name }))),
      maxTokens: 3500,
    });
    const results = (raw as { results?: unknown }).results;
    if (!Array.isArray(results)) continue;
    const valid = new Set(batch.map((b) => b.id));
    for (const r of results as { id?: string; root?: string; category?: string }[]) {
      if (!r.id || !r.root || !valid.has(r.id)) continue;
      out.set(r.id, {
        root: r.root.trim(),
        category: r.category && aisleSet.has(r.category) ? r.category : 'Other',
      });
    }
  }
  return out;
}
