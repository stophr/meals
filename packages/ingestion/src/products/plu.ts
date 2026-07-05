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
