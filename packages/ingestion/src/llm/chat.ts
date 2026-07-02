// Minimal JSON-mode chat helper for any OpenAI-compatible local server (Ollama, vLLM…).
// Used by batch jobs (ingredient linking) that want a small local text model's judgement.
// Callers validate the returned value with their own zod schema.

export interface ChatJsonOptions {
  baseUrl: string; // e.g. http://localhost:11434/v1
  model: string; // e.g. qwen2.5:7b
  apiKey?: string;
  system?: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/** Locate the first JSON value ({...} or [...]) inside possibly-fenced model output. */
export function extractJsonValue(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1]! : content).trim();
  const firstObj = body.indexOf('{');
  const firstArr = body.indexOf('[');
  const start =
    firstArr >= 0 && (firstObj < 0 || firstArr < firstObj)
      ? firstArr
      : firstObj;
  if (start < 0) return body;
  const closer = body[start] === '[' ? ']' : '}';
  const end = body.lastIndexOf(closer);
  return end > start ? body.slice(start, end + 1) : body;
}

export async function chatJson(opts: ChatJsonOptions): Promise<unknown> {
  const url = `${opts.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0,
      max_tokens: opts.maxTokens ?? 2048,
      response_format: { type: 'json_object' },
      messages: [
        ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
        { role: 'user', content: opts.prompt },
      ],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM returned an empty response');
  return JSON.parse(extractJsonValue(content));
}
