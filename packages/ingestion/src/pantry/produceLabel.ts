import Anthropic from '@anthropic-ai/sdk';
import { extractJsonValue } from '../llm/chat.js';
import type { PantryLlmConfig } from './extract.js';

// Read a produce sticker / grocery label from a photo with a vision LLM. The tiny GS1 DataBar on
// produce is unreliable to decode in-browser, but the PLU (4-5 digits) and commodity name are
// printed large — a vision model reads those. Returns the PLU (preferred), any clearly printed
// UPC, the name, and an organic flag. Two providers: the local model (default) and Claude
// (accurate digit reading — small local models misread e.g. 4012 as 4011).

export interface ProduceLabel {
  plu: string | null; // 4-5 digit PLU
  upc: string | null; // 12-14 digit barcode number, only if the DIGITS are printed
  name: string | null; // commodity / product name
  organic: boolean;
}

const PROMPT =
  'This is a close-up photo of a produce sticker or grocery label. Read the PRINTED text and ' +
  'numbers only (do NOT try to interpret the barcode itself). Read digits CAREFULLY (do not ' +
  'confuse 1/2/7). Extract:\n' +
  '- "plu": the 4- or 5-digit PLU code printed on it (e.g. "4011", "3283", "94011"). Produce ' +
  'stickers show this prominently, usually right next to the fruit/veg name. If none, null.\n' +
  '- "name": the product or commodity name printed (e.g. "Navel Orange", "Honeycrisp Apple"). null if none.\n' +
  '- "organic": true only if the label says organic, otherwise false.\n' +
  '- "upc": a longer 12-14 digit product number ONLY if those digits are clearly printed as text, else null.\n' +
  'Respond ONLY with JSON: {"plu": string|null, "name": string|null, "organic": boolean, "upc": string|null}.';

function parseLabel(text: string): ProduceLabel {
  const p = JSON.parse(extractJsonValue(text)) as Record<string, unknown>;
  const digits = (v: unknown) =>
    typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\D/g, '') : '';
  const plu = digits(p.plu);
  const upc = digits(p.upc);
  // Vision models like to hallucinate a placeholder UPC (1234567890123, all-zeros, all-same).
  const placeholder = (s: string) => s === '1234567890123' || /^(\d)\1+$/.test(s);
  return {
    plu: /^\d{4,5}$/.test(plu) ? plu : null,
    upc: /^\d{8}$|^\d{12,14}$/.test(upc) && !placeholder(upc) ? upc : null,
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : null,
    organic: p.organic === true || p.organic === 'true',
  };
}

/** Read a produce label with the local OpenAI-compatible vision model (qwen2.5vl). */
export async function extractProduceLabel(
  imageBase64: string,
  mediaType: string,
  cfg: PantryLlmConfig,
): Promise<ProduceLabel> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      max_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 60_000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('LLM returned an empty response');
  return parseLabel(text);
}

/** Read a produce label with Claude vision (accurate digit reading). SERVER-SIDE ONLY. */
export async function extractProduceLabelClaude(
  imageBase64: string,
  mediaType: string,
  cfg: { apiKey: string; model?: string },
): Promise<ProduceLabel> {
  const client = new Anthropic({ apiKey: cfg.apiKey });
  const res = await client.messages.create({
    model: cfg.model || 'claude-sonnet-5',
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType as 'image/jpeg', data: imageBase64 },
          },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  if (!text) throw new Error('Claude returned an empty response');
  return parseLabel(text);
}
