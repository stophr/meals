import { useEffect, useState } from 'react';
import { formatImperial, dimensionOf } from '@meals/shared';
import type { Unit } from '@meals/shared';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';

interface ListRow {
  id: string;
  name?: string | null;
  status: string;
  coverageStart?: string | null;
  coverageEnd?: string | null;
}
interface ListDetail extends ListRow {
  items: {
    id: string;
    canonicalItemId: string;
    quantityNeeded: string;
    unit: string;
    estimatedPrice?: string | null;
    canonicalItem: { name: string };
  }[];
}

interface ProviderRow {
  id: string;
  name: string;
}

interface ItemOption {
  providerId: string;
  providerName: string;
  productId: string;
  brand: string | null;
  size: string | null;
  price: number;
  unitPrice: number | null;
  packsNeeded: number;
  totalCost: number;
}
interface ItemWithOptions {
  itemId: string;
  name: string;
  neededBase: number;
  unit: string;
  chosenProductId: string | null;
  options: ItemOption[];
}
interface BuildStore {
  providerId: string;
  name: string;
  canFillCart: boolean;
  total: number;
  items: { name: string; brand: string | null; size: string | null; totalCost: number }[];
}
interface BuildResult {
  stores: BuildStore[];
  grandTotal: number;
  unpriced: string[];
}

function baseUnitLabel(unit: string): string {
  // Items normalize to g / ml / each; show a friendly per-unit label.
  const u = unit.toUpperCase();
  if (['G', 'KG', 'MG', 'OZ', 'LB'].includes(u)) return '/100g';
  if (['ML', 'L', 'FLOZ', 'CUP', 'TBSP', 'TSP'].includes(u)) return '/100ml';
  return '/ea';
}
function unitPriceLabel(o: ItemOption, unit: string): string {
  if (o.unitPrice == null) return '';
  const per100 = ['/100g', '/100ml'].includes(baseUnitLabel(unit));
  const v = per100 ? o.unitPrice * 100 : o.unitPrice;
  return ` ($${v.toFixed(2)}${baseUnitLabel(unit)})`;
}

// Map a provider (by name) to its store search URL + icon, so the link chips and the save
// dropdown are always the same set of stores.
const STORE_TEMPLATES: { match: RegExp; icon: string; url: (q: string) => string }[] = [
  { match: /costco/i, icon: '🏬', url: (q) => `https://www.costco.com/CatalogSearch?keyword=${encodeURIComponent(q)}` },
  { match: /fry/i, icon: '🔴', url: (q) => `https://www.frysfood.com/search?query=${encodeURIComponent(q)}` },
  { match: /walmart/i, icon: '🛒', url: (q) => `https://www.walmart.com/search?q=${encodeURIComponent(q)}` },
  { match: /safeway/i, icon: '🔵', url: (q) => `https://www.safeway.com/shop/search-results.html?q=${encodeURIComponent(q)}` },
];

function storeTemplate(name: string) {
  return STORE_TEMPLATES.find((t) => t.match.test(name));
}

/** Tap a store to open the item there; type the price you see; it's saved for that store. */
function PriceCapture({
  item,
  providers,
  onSaved,
}: {
  item: ListDetail['items'][number];
  providers: ProviderRow[];
  onSaved: (msg: string) => void;
}) {
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [price, setPrice] = useState('');
  const [size, setSize] = useState('');
  const [brand, setBrand] = useState('');
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [parsing, setParsing] = useState(false);

  async function parse() {
    if (!paste.trim()) return;
    setParsing(true);
    try {
      const r = await api.post<{ brand?: string; size?: string; price?: number; message?: string }>(
        '/integrations/parse-price-one',
        { text: paste, itemName: item.canonicalItem.name },
      );
      if (r.message) {
        onSaved(r.message);
      } else {
        if (r.brand) setBrand(r.brand);
        if (r.size) setSize(r.size);
        if (r.price != null) setPrice(String(r.price));
      }
    } catch (e) {
      onSaved(e instanceof Error ? e.message : String(e));
    } finally {
      setParsing(false);
    }
  }

  async function save() {
    if (!providerId || !price) return;
    setBusy(true);
    try {
      await api.post(`/providers/${providerId}/quick-price`, {
        canonicalItemId: item.canonicalItemId,
        price: Number(price),
        size: size.trim() || undefined,
        brand: brand.trim() || undefined,
      });
      const store = providers.find((p) => p.id === providerId)?.name ?? 'store';
      onSaved(`Saved $${Number(price).toFixed(2)} for ${item.canonicalItem.name} at ${store}.`);
      setPrice('');
      setSize('');
      setBrand('');
      setPaste('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="price-capture">
      <div className="store-links">
        {providers.map((p) => {
          const t = storeTemplate(p.name);
          if (!t) return null;
          // Tapping a store opens it AND selects it for the price you're about to save.
          return (
            <a
              key={p.id}
              className="store-link"
              href={t.url(item.canonicalItem.name)}
              target="_blank"
              rel="noreferrer"
              onClick={() => setProviderId(p.id)}
            >
              {t.icon} {p.name.replace(/\s*\(.*\)$/, '')}
            </a>
          );
        })}
      </div>
      <div className="capture-row">
        <textarea
          className="paste-box"
          rows={2}
          placeholder="Paste product description here, then Parse…"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
        />
        <button className="btn btn-inline" disabled={parsing || !paste.trim()} onClick={parse}>
          {parsing ? '…' : '✨ Parse'}
        </button>
      </div>
      <div className="capture-row">
        <select className="chip" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          className="size-input"
          placeholder="brand"
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
        />
        <input
          className="size-input"
          placeholder="size"
          value={size}
          onChange={(e) => setSize(e.target.value)}
        />
        <input
          className="price-input"
          type="number"
          inputMode="decimal"
          placeholder="$ price"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
        <button className="btn btn-inline" disabled={busy || !price} onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}

interface Coupon {
  id: string;
  description: string;
  brand?: string | null;
  valueText?: string | null;
  matchedItemName?: string | null;
  expiresAt?: string | null;
}

/** Digital-coupon approvals: the clip script only clips what's approved here. */
function CouponsPanel() {
  const [coupons, setCoupons] = useState<Coupon[]>();
  const [msg, setMsg] = useState<string>();

  async function load() {
    setCoupons(await api.get<Coupon[]>('/integrations/kroger/coupons'));
  }
  useEffect(() => {
    load().catch(() => setCoupons([]));
  }, []);

  async function act(id: string, action: 'approve' | 'dismiss') {
    setCoupons((cs) => cs?.filter((c) => c.id !== id));
    await api.post(`/integrations/kroger/coupons/${id}/${action}`);
  }

  async function approveMatched() {
    const res = await api.post<{ approved: number }>('/integrations/kroger/coupons/approve-matched');
    setMsg(`${res.approved} matched coupon(s) approved — run the clip script to clip them.`);
    await load();
  }

  if (!coupons || coupons.length === 0) return null;
  const matchedFirst = [...coupons].sort((a, b) =>
    a.matchedItemName === b.matchedItemName ? 0 : a.matchedItemName ? -1 : 1,
  );
  return (
    <div className="card coupons-card">
      <div className="page-head">
        <div className="card-title">💸 Fry's digital coupons ({coupons.length})</div>
        <button className="btn-link" onClick={approveMatched}>
          approve all matched
        </button>
      </div>
      {msg && <p className="notice">{msg}</p>}
      <ul className="plan-entries">
        {matchedFirst.slice(0, 30).map((c) => (
          <li key={c.id}>
            <span className="plan-recipe">
              {c.matchedItemName && <span className="badge badge-ok">{c.matchedItemName}</span>}{' '}
              {c.valueText && <strong>{c.valueText} </strong>}
              {c.brand ? `${c.brand} — ` : ''}
              {c.description}
            </span>
            <button className="btn-link" onClick={() => act(c.id, 'approve')}>
              ✓
            </button>
            <button className="entry-x" onClick={() => act(c.id, 'dismiss')}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      <p className="muted sheet-hint">
        Approving stages a coupon; clipping happens when the clip script runs (see docs/ordering.md).
      </p>
    </div>
  );
}

export function Shopping() {
  const { data: lists, error, loading } = useApi<ListRow[]>(() => api.get('/shopping-lists'), []);
  const { data: providers } = useApi<ProviderRow[]>(() => api.get('/providers'), []);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<ListDetail>();
  const [options, setOptions] = useState<ItemWithOptions[]>();
  const [build, setBuild] = useState<BuildResult>();
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState<string>();
  const [priceMsg, setPriceMsg] = useState<string>();

  async function loadOptions(id: string) {
    const res = await api.get<{ items: ItemWithOptions[] }>(`/shopping-lists/${id}/options`);
    setOptions(res.items);
  }
  async function open(id: string) {
    setSelected(id);
    setBuild(undefined);
    setDetail(await api.get<ListDetail>(`/shopping-lists/${id}`));
    await loadOptions(id);
  }

  async function autoSelect(mode: 'unit' | 'total') {
    if (!selected) return;
    setBusy(true);
    try {
      const r = await api.post<{ selected: number; unpriced: number }>(
        `/shopping-lists/${selected}/auto-select`,
        { mode },
      );
      setPriceMsg(
        `Picked best ${mode === 'unit' ? 'unit price' : 'total'} for ${r.selected} item(s)` +
          (r.unpriced ? `, ${r.unpriced} still unpriced.` : '.'),
      );
      await loadOptions(selected);
      setBuild(undefined);
    } finally {
      setBusy(false);
    }
  }

  async function chooseOption(itemId: string, o: ItemOption) {
    if (!selected) return;
    await api.patch(`/shopping-lists/${selected}/items/${itemId}`, {
      assignedProviderId: o.providerId,
      chosenProductId: o.productId,
    });
    await loadOptions(selected);
    setBuild(undefined);
  }

  async function buildLists() {
    if (!selected) return;
    setBusy(true);
    try {
      setBuild(await api.post<BuildResult>(`/shopping-lists/${selected}/build`));
    } finally {
      setBusy(false);
    }
  }

  async function fillCart(store: BuildStore) {
    if (!selected) return;
    setBusy(true);
    setPriceMsg(undefined);
    try {
      const r = await api.post<{ pushed?: number; message?: string }>(
        `/shopping-lists/${selected}/kroger-cart`,
        { providerId: store.providerId },
      );
      setPriceMsg(r.message ?? `Added ${r.pushed} item(s) to your ${store.name} cart.`);
    } catch (e) {
      setPriceMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page">
      <h2>Shopping</h2>
      {!selected && <CouponsPanel />}
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}

      {!selected && (
        <ul className="card-list">
          {lists?.length === 0 && (
            <p className="muted">No lists yet — use “🛒 I'm going to the grocery store” on the Plan tab.</p>
          )}
          {lists?.map((l) => (
            <li key={l.id} className="card card-row" onClick={() => open(l.id)}>
              <div className="card-main">
                <div className="card-title">{l.name ?? 'Shopping list'}</div>
                <div className="card-sub">
                  {l.status}
                  {l.coverageStart &&
                    l.coverageEnd &&
                    ` · locks ${new Date(l.coverageStart).getMonth() + 1}/${new Date(l.coverageStart).getDate()}–${new Date(l.coverageEnd).getMonth() + 1}/${new Date(l.coverageEnd).getDate()}`}
                </div>
              </div>
              <button
                className="entry-x"
                title="Delete list (unlocks its days)"
                onClick={async (e) => {
                  e.stopPropagation();
                  await api.del(`/shopping-lists/${l.id}`);
                  location.reload();
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && detail && (
        <div>
          <button className="btn-link" onClick={() => setSelected(undefined)}>
            ← All lists
          </button>
          <h3>{detail.name ?? 'Shopping list'}</h3>

          <div className="chips">
            <button className="chip" disabled={busy} onClick={() => autoSelect('total')}>
              💵 Best total
            </button>
            <button className="chip" disabled={busy} onClick={() => autoSelect('unit')}>
              ⚖️ Best unit price
            </button>
            <button className="chip active" disabled={busy} onClick={buildLists}>
              🧾 Build lists
            </button>
          </div>
          {priceMsg && <p className="notice">{priceMsg}</p>}

          {build && (
            <div className="build">
              <div className="card-title">Lists by store — total ${build.grandTotal.toFixed(2)}</div>
              {build.stores.map((s) => (
                <div key={s.providerId} className="card build-store">
                  <div className="page-head">
                    <strong>{s.name}</strong>
                    <span>${s.total.toFixed(2)}</span>
                  </div>
                  <ul className="build-items">
                    {s.items.map((it, i) => (
                      <li key={i}>
                        <span>
                          {it.name}
                          {it.brand ? ` · ${it.brand}` : ''}
                          {it.size ? ` · ${it.size}` : ''}
                        </span>
                        <span>${it.totalCost.toFixed(2)}</span>
                      </li>
                    ))}
                  </ul>
                  {s.canFillCart ? (
                    <button className="btn" disabled={busy} onClick={() => fillCart(s)}>
                      🛒 Fill {s.name} cart
                    </button>
                  ) : (
                    <p className="muted sheet-hint">Manual list (no cart integration for this store).</p>
                  )}
                </div>
              ))}
              {build.unpriced.length > 0 && (
                <p className="muted sheet-hint">
                  No price yet: {build.unpriced.join(', ')} — use 💲 check price below.
                </p>
              )}
            </div>
          )}

          <ul className="card-list">
            {detail.items.map((it) => {
              const opt = options?.find((o) => o.itemId === it.id);
              const chosen =
                opt?.options.find((o) => o.productId === opt.chosenProductId) ?? opt?.options[0];
              return (
                <li key={it.id} className="card">
                  <div className="page-head">
                    <div>
                      <div className="card-title">{it.canonicalItem.name}</div>
                      <div className="card-sub">
                        {formatImperial(Number(it.quantityNeeded), dimensionOf(it.unit as Unit))}
                      </div>
                    </div>
                    <button
                      className="btn-link"
                      onClick={() => setCapturing(capturing === it.id ? undefined : it.id)}
                    >
                      {capturing === it.id ? 'close' : '💲 check price'}
                    </button>
                  </div>

                  {chosen ? (
                    <div className="chosen">
                      <span className="badge badge-ok">{chosen.providerName}</span>{' '}
                      {chosen.brand ? `${chosen.brand} · ` : ''}
                      {chosen.size ? `${chosen.size} · ` : ''}
                      <strong>${chosen.totalCost.toFixed(2)}</strong>
                      <span className="muted">{unitPriceLabel(chosen, it.unit)}</span>
                    </div>
                  ) : (
                    <div className="card-sub muted">No price yet — 💲 check price</div>
                  )}

                  {opt && opt.options.length > 1 && (
                    <select
                      className="chip option-select"
                      value={chosen?.productId ?? ''}
                      onChange={(e) => {
                        const o = opt.options.find((x) => x.productId === e.target.value);
                        if (o) chooseOption(it.id, o);
                      }}
                    >
                      {opt.options.map((o) => (
                        <option key={o.productId} value={o.productId}>
                          {o.providerName} · {o.brand ?? ''} {o.size ?? ''} · ${o.totalCost.toFixed(2)}
                          {unitPriceLabel(o, it.unit)}
                        </option>
                      ))}
                    </select>
                  )}

                  {capturing === it.id && (
                    <PriceCapture
                      item={it}
                      providers={providers ?? []}
                      onSaved={(m) => {
                        setPriceMsg(m);
                        loadOptions(selected!);
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
