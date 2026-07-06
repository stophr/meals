import { resolvePlu } from '@meals/ingestion';
import { env } from '../env.js';

// Read a produce sticker via the PaddleOCR (RapidOCR) sidecar, then turn the raw text into a PLU
// using the IFPS table as a cross-check. This is fast and precise on digits, and the table +
// printed-name check filters misreads: a decoded 4-5 digit token is only accepted when it's a
// real PLU AND (preferably) its commodity matches other text on the sticker. So "4011" won't win
// on a sticker that says "NAVEL".

export interface ProduceLabelRead {
  plu: string | null;
  upc: string | null;
  name: string | null;
  organic: boolean;
}

const STOP = new Set(['large', 'small', 'medium', 'organic', 'fresh', 'each', 'with', 'baby', 'mini']);
function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP.has(w))
      .map((w) => w.replace(/s$/, '')),
  );
}
function sharesWord(a: string, b: string): boolean {
  const A = words(a);
  const B = words(b);
  for (const w of A) if (B.has(w)) return true;
  return false;
}

async function readTextLines(imageBase64: string): Promise<string[]> {
  const res = await fetch(`${env.PADDLE_OCR_URL.replace(/\/$/, '')}/ocr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ imageBase64 }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`PaddleOCR HTTP ${res.status}`);
  const data = (await res.json()) as { lines?: { text: string; conf: number }[] };
  return (data.lines ?? []).filter((l) => (l.conf ?? 0) >= 0.5 && l.text.trim()).map((l) => l.text.trim());
}

/** Longest mostly-alphabetic line — a decent product-name guess when no PLU resolves. */
function nameGuess(lines: string[]): string | null {
  const cand = lines
    .filter((l) => (l.match(/[a-z]/gi) ?? []).length >= 3)
    .sort((a, b) => b.length - a.length)[0];
  return cand ?? null;
}

export async function readProduceLabelPaddle(imageBase64: string): Promise<ProduceLabelRead | null> {
  const lines = await readTextLines(imageBase64); // throws if the sidecar is unreachable
  if (!lines.length) return null;
  const text = lines.join(' ');
  const organic = /\borganic\b/i.test(text);

  // 4-5 digit tokens that are real PLUs.
  const cands = [
    ...new Set(lines.flatMap((l) => l.match(/\b\d{4,5}\b/g) ?? []).filter((d) => resolvePlu(d))),
  ];
  if (!cands.length) return { plu: null, upc: null, name: nameGuess(lines), organic };

  // Prefer the PLU whose commodity matches other printed text; else use it only if unambiguous.
  const matched = cands.find((d) => sharesWord(resolvePlu(d)!.commodity, text));
  const chosen = matched ?? (cands.length === 1 ? cands[0]! : null);
  if (!chosen) return { plu: null, upc: null, name: nameGuess(lines), organic }; // ambiguous

  return { plu: chosen, upc: null, name: resolvePlu(chosen)!.commodity, organic };
}
