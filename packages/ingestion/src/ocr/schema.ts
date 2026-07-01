// Shared receipt/flyer OCR contract used by every provider (Claude, local VLM, …).
// The Zod schema is the single source of truth: providers validate against it, and the
// local provider also derives a JSON Schema from it for structured-output decoding.
import * as z from 'zod/v4';

export const supportedMediaTypes = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;
export type ReceiptMediaType = (typeof supportedMediaTypes)[number];

const extractedLineSchema = z.object({
  rawName: z.string(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  unitPrice: z.number().nullable(),
  totalPrice: z.number().nullable(),
  isDeal: z.boolean(),
});

export const receiptSchema = z.object({
  store: z.string().nullable(),
  date: z.string().nullable(),
  total: z.number().nullable(),
  currency: z.string().nullable(),
  lines: z.array(extractedLineSchema),
});

export type ExtractedReceiptLine = z.infer<typeof extractedLineSchema>;
export type ExtractedReceipt = z.infer<typeof receiptSchema>;

// JSON Schema for OpenAI-compatible `response_format: { type: 'json_schema' }` (vLLM/Ollama).
export const receiptJsonSchema = z.toJSONSchema(receiptSchema);

export type OcrProvider = 'local' | 'claude';

export interface ReceiptExtractionResult {
  receipt: ExtractedReceipt;
  /** Fraction agreement between summed line totals and the printed total, in [0,1]. */
  confidence: number;
  modelUsed: string;
}

export interface ExtractReceiptInput {
  imageBase64: string; // base64 WITHOUT newlines
  mediaType: ReceiptMediaType;
  provider: OcrProvider;
  local?: LocalOcrConfig;
  claude?: ClaudeOcrConfig;
}

export interface LocalOcrConfig {
  /** OpenAI-compatible base URL, e.g. http://localhost:8000/v1 (vLLM) or http://localhost:11434/v1 (Ollama). */
  baseUrl: string;
  model: string; // e.g. "Qwen/Qwen2.5-VL-3B-Instruct"
  apiKey?: string; // usually a dummy for local servers
}

export interface ClaudeOcrConfig {
  apiKey: string;
  model?: string;
  escalationModel?: string;
  confidenceThreshold?: number;
}

export const RECEIPT_PROMPT = `You are extracting structured line items from a photo of a grocery receipt or store flyer.
Read the image row by row. Each line item is one horizontal row: the item text is on the left and
the price for THAT row is on the far right of the SAME row. Align each price with the item on its
own row — do not shift prices between rows.

Return every purchasable line item. For each line:
- rawName: the full item text as printed, INCLUDING any size/pack info (e.g. "Milk 2% 1gal",
  "All-Purpose Flour 2kg"). Keep abbreviations.
- totalPrice: the price printed on that row (this is the amount that sums to the receipt total).
  Put the row's price HERE, not in unitPrice.
- unitPrice: only if a separate per-unit price (e.g. "$/kg") is also printed; otherwise null.
- quantity: numeric count if printed; otherwise null.
- unit: a measurement unit only (kg, g, ml, l, ea) if printed separately; otherwise null.
  Do NOT put pack size here — pack size stays in rawName.
- isDeal: true if the row shows a sale/multi-buy/loyalty price.

Also capture the store name, date (ISO-8601 if legible), grand total, and currency if visible.
Do not invent items or prices. If a value is illegible, use null.
The sum of all totalPrice values should approximately equal the receipt total — re-check your
row alignment if it does not.
Respond with ONLY the JSON object, no prose or code fences.`;

/** Sum of line totals vs printed total → confidence in [0,1]. 1 when we can't cross-check. */
export function scoreConfidence(receipt: ExtractedReceipt): number {
  if (receipt.total == null || receipt.total <= 0) return 1;
  const summed = receipt.lines.reduce((s, l) => s + (l.totalPrice ?? 0), 0);
  if (summed <= 0) return 0;
  const diff = Math.abs(summed - receipt.total) / receipt.total;
  return Math.max(0, 1 - diff);
}
