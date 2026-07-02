// Assisted cart-building links for chains WITHOUT a usable public API (Walmart, Safeway).
// No middleman, no markup: links open the store's own site/app at first-party prices.
// See docs/ordering.md for the research behind each format.

export interface CartLinkItem {
  name: string;
  quantity?: number;
  /** Store-native item id when known (Walmart itemId enables true add-to-cart links). */
  itemId?: string;
}

/**
 * Walmart add-to-cart deep link (officially documented Add-to-Cart proxy format:
 * walmart.io/docs/atc/v1/add-to-cart): items=ITEMID_QTY,ITEMID_QTY[&storeId=].
 * Pre-fills the user's actual walmart.com cart at first-party prices — no middleman.
 * Falls back to a search link per item when ids are unknown.
 */
export function walmartCartLink(
  items: CartLinkItem[],
  storeId?: string,
): { cartUrl?: string; searchUrls: { name: string; url: string }[] } {
  const withIds = items.filter((i) => i.itemId);
  const withoutIds = items.filter((i) => !i.itemId);
  const itemsParam = withIds
    .map((i) => `${i.itemId}${i.quantity && i.quantity > 1 ? `_${Math.ceil(i.quantity)}` : ''}`)
    .join(',');
  return {
    cartUrl: withIds.length
      ? `https://www.walmart.com/sc/cart/addToCart?items=${itemsParam}${storeId ? `&storeId=${storeId}` : ''}`
      : undefined,
    searchUrls: withoutIds.map((i) => ({
      name: i.name,
      url: `https://www.walmart.com/search?q=${encodeURIComponent(i.name)}`,
    })),
  };
}

/** Safeway has no cart URL scheme — per-item search deep links into safeway.com. */
export function safewaySearchLinks(items: CartLinkItem[]): { name: string; url: string }[] {
  return items.map((i) => ({
    name: i.name,
    url: `https://www.safeway.com/shop/search-results.html?q=${encodeURIComponent(i.name)}`,
  }));
}
