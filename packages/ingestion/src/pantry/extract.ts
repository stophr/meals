import { extractJsonValue } from '../llm/chat.js';

// Extract on-hand pantry items from a free-text description or a photo, using a local
// OpenAI-compatible server (Ollama: qwen2.5:7b for text, qwen2.5vl:3b for vision). Returns a
// PREVIEW list the user confirms before anything is written to inventory.

export interface ExtractedPantryItem {
  name: string; // buyable ingredient name (no brand)
  brand: string | null; // brand if mentioned, else null
  quantity: number;
  unit: string; // free unit word; normalized to the Unit enum by the API
}

export interface PantryLlmConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

const PROMPT =
  'You are cataloging a pantry from a person rambling about what they have. The description may ' +
  'be long, conversational, and out of order. Extract EVERY distinct food/grocery item. For each:\n' +
  '- "name": the plain buyable ingredient in Title Case, WITHOUT the brand or prep words ' +
  '(e.g. "Peanut Butter", not "Jif crunchy peanut butter").\n' +
  '- "brand": the brand name if they mention one (e.g. "Jif", "Kirkland"), otherwise null.\n' +
  '- "quantity": a number. Interpret vague amounts sensibly ("a couple"->2, "a dozen"->12, ' +
  '"half a bag"->0.5, "a few"->3, "some"->1).\n' +
  '- "unit": one of lb, oz, g, kg, cup, tbsp, tsp, fl oz, ml, l, each, pack, can, bottle, bunch, jar, box, bag. ' +
  'Use "each" for whole counts (3 eggs -> 3 each). If truly unclear, use 1 each.\n' +
  'Merge duplicates, ignore non-food objects and filler words. ' +
  'Respond ONLY with JSON {"items":[{"name","brand","quantity","unit"}]}.';

interface ChatResp {
  choices?: { message?: { content?: string | null } }[];
}

async function callChat(cfg: PantryLlmConfig, content: unknown): Promise<ExtractedPantryItem[]> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      max_tokens: 6000, // a long rambling dump can list many items
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 180_000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const data = (await res.json()) as ChatResp;
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('LLM returned an empty response');
  const parsed = JSON.parse(extractJsonValue(text)) as { items?: unknown };
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return items
    .map((i) => i as Record<string, unknown>)
    .filter((i) => i && typeof i.name === 'string' && (i.name as string).trim())
    .map((i) => ({
      name: String(i.name).trim(),
      brand: typeof i.brand === 'string' && i.brand.trim() ? i.brand.trim() : null,
      quantity: Number(i.quantity) > 0 ? Number(i.quantity) : 1,
      unit: typeof i.unit === 'string' && i.unit.trim() ? i.unit.trim() : 'each',
    }));
}

/** Parse a spoken/typed description ("two pounds of chicken, a dozen eggs, half a bag of rice"). */
export function extractPantryFromText(text: string, cfg: PantryLlmConfig) {
  return callChat(cfg, `${PROMPT}\n\nDescription:\n${text}`);
}

/** Parse a photo of a pantry/fridge/haul. */
export function extractPantryFromImage(
  imageBase64: string,
  mediaType: string,
  cfg: PantryLlmConfig,
) {
  return callChat(cfg, [
    { type: 'text', text: PROMPT },
    { type: 'image_url', image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
  ]);
}
