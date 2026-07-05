// Produce PLU codes (Price Look-Up) — the 4-5 digit numbers on loose-produce stickers, a
// separate namespace from UPC/EAN barcodes. 4-digit = conventional; a leading 9 (→ 5 digits) =
// organic. Maps to a generic commodity name; nutrition then comes from USDA-by-name (produce is
// generic, so USDA is exactly right).

import { PLU_CODES } from './pluCodes.js';

export interface PluResult {
  code: string; // as entered (4 or 5 digits)
  base: string; // the 4-digit base code
  commodity: string; // "Bananas"
  name: string; // "Organic Bananas" when organic, else the commodity
  organic: boolean;
}

/** A 4-5 digit produce PLU (not a UPC). */
export function looksLikePlu(raw: string): boolean {
  return /^\d{4,5}$/.test((raw ?? '').replace(/\D/g, ''));
}

export function resolvePlu(raw: string): PluResult | null {
  const d = (raw ?? '').replace(/\D/g, '');
  if (!/^\d{4,5}$/.test(d)) return null;
  let base = d;
  let organic = false;
  if (d.length === 5) {
    if (!d.startsWith('9')) return null; // only the organic (9xxxx) form is a valid 5-digit PLU
    base = d.slice(1);
    organic = true;
  }
  const commodity = PLU_CODES[base];
  if (!commodity) return null;
  return { code: d, base, commodity, name: organic ? `Organic ${commodity}` : commodity, organic };
}

/**
 * Extract a PLU from any decoded value: a raw 4-5 digit code, OR a GS1 DataBar / GTIN that
 * embeds the PLU as a mostly-zero-padded number (e.g. banana DataBar decodes to the GTIN-14
 * `00000000040115` = 4011 + check digit; RSS-Expanded may prefix the `(01)` AI). Only returns a
 * hit when the reduced number is a real PLU, so it never hijacks a genuine product UPC.
 */
export function extractPlu(raw: string): PluResult | null {
  let d = (raw ?? '').replace(/\D/g, '');
  if (!d) return null;

  const direct = resolvePlu(d);
  if (direct) return direct;

  if (d.length === 16 && d.startsWith('01')) d = d.slice(2); // strip GS1 (01) AI -> GTIN-14
  if (d.length >= 8) {
    for (const c of [d.slice(0, -1).replace(/^0+/, ''), d.replace(/^0+/, '')]) {
      const r = resolvePlu(c); // drop the GTIN check digit and/or leading zeros
      if (r) return r;
    }
  }
  return null;
}
