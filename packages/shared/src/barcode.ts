// Barcode identity: the single owner of "map any scanned code to the corpus key".
// Kroger (and our crawled corpus) index products by the UPC-A base WITHOUT its check digit,
// zero-padded to 13 (UPC-A 041449403205 → 0004144940320). Scanned barcodes carry the check
// digit as 8 (UPC-E), 12 (UPC-A), 13 (EAN-13), or 14 (GTIN-14) digits — every form must land
// on the identical key or a scan misses the good Kroger data and falls back to worse sources.

/** Strip separators and validate as an 8/12/13/14-digit retail barcode. Returns null if bogus. */
export function normalizeUpc(raw: string): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  // 8 = UPC-E, 12 = UPC-A, 13 = EAN-13, 14 = GTIN-14 (all carry a check digit).
  return /^\d{8}$|^\d{12,14}$/.test(digits) ? digits : null;
}

/**
 * Expand an 8-digit UPC-E to its 12-digit UPC-A form (keeps the original check digit).
 * Returns null when the number system isn't 0/1 — those 8-digit codes are EAN-8, a different
 * symbology with no UPC-A expansion.
 */
function expandUpcE(d: string): string | null {
  const ns = d[0];
  if (ns !== '0' && ns !== '1') return null;
  const [d1, d2, d3, d4, d5, d6] = d.slice(1, 7);
  const check = d[7];
  let body: string;
  if (d6 === '0' || d6 === '1' || d6 === '2') body = `${d1}${d2}${d6}0000${d3}${d4}${d5}`;
  else if (d6 === '3') body = `${d1}${d2}${d3}00000${d4}${d5}`;
  else if (d6 === '4') body = `${d1}${d2}${d3}${d4}00000${d5}`;
  else body = `${d1}${d2}${d3}${d4}${d5}0000${d6}`;
  return `${ns}${body}${check}`;
}

/**
 * Map a scanned barcode to the Kroger/corpus product key: drop the trailing check digit and
 * left-pad to 13. UPC-E is expanded to UPC-A first. Returns null for lengths that don't carry
 * a check digit (nothing sane to key on).
 */
export function krogerProductKey(upc: string): string | null {
  let d = (upc ?? '').replace(/\D/g, '');
  if (d.length === 8) {
    const expanded = expandUpcE(d);
    if (!expanded) return null;
    d = expanded;
  }
  if (d.length >= 12 && d.length <= 14) return d.slice(0, -1).padStart(13, '0');
  return null;
}

/**
 * The UPC forms a corpus/provider lookup must try: the code as scanned plus its corpus key
 * (crawled Kroger rows are keyed check-digit-less; OFF/manual rows keep the scanned form).
 */
export function upcLookupForms(upc: string): string[] {
  const d = (upc ?? '').replace(/\D/g, '');
  const key = krogerProductKey(d);
  return key && key !== d ? [d, key] : [d];
}
