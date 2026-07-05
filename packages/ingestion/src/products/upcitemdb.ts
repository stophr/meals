// UPCitemdb client — broad UPC → title/brand/size + product images. Used as the LAST-RESORT
// description source (great titles, image links) when Fry's and OFF both miss. The free "trial"
// endpoint needs no key but is rate-limited (~100/day, a few/min); a paid key uses the prod
// endpoint with auth headers.

export interface UpcItemDbConfig {
  key?: string; // empty => free trial endpoint
  baseUrl?: string; // paid endpoint base, default https://api.upcitemdb.com/prod/v1
}

export interface UpcItemDbProduct {
  description: string;
  brand: string | null;
  sizeText: string | null;
  imageUrl: string | null;
}

interface RawItem {
  title?: string;
  brand?: string;
  description?: string;
  size?: string;
  images?: string[];
}

export async function lookupUpcItemDb(cfg: UpcItemDbConfig, upc: string): Promise<UpcItemDbProduct | null> {
  const code = upc.replace(/\D/g, '');
  const trial = !cfg.key;
  const url = trial
    ? `https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`
    : `${(cfg.baseUrl ?? 'https://api.upcitemdb.com/prod/v1').replace(/\/$/, '')}/lookup?upc=${code}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (!trial) {
    headers['user_key'] = cfg.key!;
    headers['key_type'] = '3scale';
  }
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null; // includes 429 rate-limited -> just skip
    const data = (await res.json()) as { items?: RawItem[] };
    const it = data.items?.[0];
    const description = (it?.title || it?.description || '').trim();
    if (!description) return null;
    return {
      description,
      brand: it?.brand?.trim() || null,
      sizeText: it?.size?.trim() || null,
      imageUrl: (it?.images ?? []).find((u) => !!u) || null,
    };
  } catch {
    return null;
  }
}
