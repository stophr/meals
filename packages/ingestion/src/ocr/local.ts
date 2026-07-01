import {
  receiptSchema,
  receiptJsonSchema,
  RECEIPT_PROMPT,
  scoreConfidence,
  type ExtractReceiptInput,
  type LocalOcrConfig,
  type ReceiptExtractionResult,
} from './schema.js';

// Local VLM OCR provider. Talks to any OpenAI-compatible server (vLLM, Ollama, LM Studio…)
// running a vision model such as Qwen2.5-VL-3B-Instruct. Fully offline — no data leaves the host.

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
}

/** Strip ```json fences a model may wrap the JSON in, then locate the JSON object. */
function extractJsonText(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1]! : content).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

export async function extractWithLocal(
  input: ExtractReceiptInput,
  cfg: LocalOcrConfig,
): Promise<ReceiptExtractionResult> {
  if (!cfg.baseUrl) throw new Error('OCR_LOCAL_BASE_URL is required for the local OCR provider');

  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 2048,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: RECEIPT_PROMPT },
            {
              type: 'image_url',
              image_url: { url: `data:${input.mediaType};base64,${input.imageBase64}` },
            },
          ],
        },
      ],
      // Structured-output decoding where the server supports it (vLLM guided_json / Ollama).
      // Servers that ignore this still return JSON text thanks to the prompt.
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'receipt', schema: receiptJsonSchema, strict: true },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Local OCR HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }

  const data = (await res.json()) as ChatCompletion;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Local OCR returned an empty response');

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(content));
  } catch {
    throw new Error(`Local OCR did not return valid JSON: ${content.slice(0, 200)}`);
  }

  const receipt = receiptSchema.parse(parsed);
  return { receipt, confidence: scoreConfidence(receipt), modelUsed: cfg.model };
}
