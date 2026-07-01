// Per-store scraper adapters (Phase 2). Each store implements one adapter behind this
// common interface; the api schedules jobs that call fetchListings() then normalizes +
// matches the results into PriceObservations. Quarantined here because this is the most
// fragile, ToS-sensitive part of the system.

export interface RawListing {
  rawName: string;
  brand?: string;
  sizeText?: string;
  price?: number;
  regularPrice?: number;
  isDeal?: boolean;
  upc?: string;
  url?: string;
  imageUrl?: string;
}

export interface ScraperContext {
  providerId: string;
  // Optional store-specific config (location id, flyer url, etc.).
  config?: Record<string, unknown>;
}

export interface ScraperAdapter {
  /** Stable key, e.g. "loblaws" — matched against a Provider's configured scraper. */
  readonly key: string;
  readonly displayName: string;
  fetchListings(ctx: ScraperContext): Promise<RawListing[]>;
}

// Registry is empty in the MVP; Phase 2 registers concrete adapters here.
export const scraperRegistry = new Map<string, ScraperAdapter>();

export function registerScraper(adapter: ScraperAdapter): void {
  scraperRegistry.set(adapter.key, adapter);
}
