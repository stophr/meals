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
Return every purchasable line item you can read. For each line:
- rawName: the item text exactly as printed (keep abbreviations, e.g. "GV MLK 2% 1G")
- quantity / unit: only if printed; otherwise null
- unitPrice / totalPrice: numeric prices without currency symbols; null if not shown
- isDeal: true if the line is a sale/multi-buy/loyalty price
Also capture the store name, date (ISO-8601 if legible), grand total, and currency if visible.
Do not invent items or prices. If a value is illegible, use null.
Respond with ONLY the JSON object, no prose or code fences.`;

/** Sum of line totals vs printed total → confidence in [0,1]. 1 when we can't cross-check. */
export function scoreConfidence(receipt: ExtractedReceipt): number {
  if (receipt.total == null || receipt.total <= 0) return 1;
  const summed = receipt.lines.reduce((s, l) => s + (l.totalPrice ?? 0), 0);
  if (summed <= 0) return 0;
  const diff = Math.abs(summed - receipt.total) / receipt.total;
  return Math.max(0, 1 - diff);
}
