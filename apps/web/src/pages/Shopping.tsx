import { useEffect, useState } from 'react';
import { formatImperial, dimensionOf } from '@meals/shared';
import type { Unit } from '@meals/shared';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { BarcodeScanner } from '../components/BarcodeScanner.js';

interface ListRow {
  id: string;
  name?: string | null;
  status: string;
  coverageStart?: string | null;
  coverageEnd?: string | null;
  archivedAt?: string | null;
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
  mode: 'total' | 'unit';
  chosenProductId: string | null;
  preferredBrand: string | null;
  preferredBrandUnavailable: boolean;
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

const UNIT_GROUPS: { label: string; units: string[] }[] = [
  { label: 'Weight', units: ['LB', 'OZ', 'G', 'KG'] },
  { label: 'Volume', units: ['CUP', 'TBSP', 'TSP', 'FLOZ', 'ML', 'L'] },
  { label: 'Count', units: ['EACH', 'PACK', 'CAN', 'BOTTLE', 'BUNCH'] },
];
const DEFAULT_UNIT: Record<string, string> = { MASS: 'LB', VOLUME: 'CUP', COUNT: 'EACH' };
function defaultUnitFor(baseUnit?: string | null): string {
  return baseUnit ? DEFAULT_UNIT[dimensionOf(baseUnit as Unit)] ?? 'EACH' : 'EACH';
}
function UnitSelect({ value, onChange }: { value: string; onChange: (u: string) => void }) {
  return (
    <select className="chip" value={value} onChange={(e) => onChange(e.target.value)}>
      {UNIT_GROUPS.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.units.map((u) => (
            <option key={u} value={u}>
              {u.toLowerCase()}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** Second window for swapping a list item: search/filter its products, or scan the UPC. */
function SwapModal({
  item,
  unit,
  onPick,
  onScan,
  onClose,
}: {
  item: ItemWithOptions;
  unit: string;
  onPick: (o: ItemOption) => void;
  onScan: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const opts = item.options.filter((o) => {
    const s = `${o.providerName} ${o.brand ?? ''} ${o.size ?? ''}`.toLowerCase();
    return !q.trim() || s.includes(q.toLowerCase());
  });
  return (
    <div className="sheet swap-sheet">
      <div className="sheet-title">Swap: {item.name}</div>
      <div className="sheet-row">
        <input
          className="sheet-input sheet-input-wide"
          placeholder="search brand or size…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <button className="btn btn-inline" onClick={onScan}>
          📷 Scan
        </button>
      </div>
      <div className="swap-opts">
        {opts.map((o) => (
          <button key={o.productId} className="swap-opt" onClick={() => onPick(o)}>
            <span>
              <strong>{o.brand ?? '—'}</strong> {o.size ? <span className="muted">· {o.size}</span> : ''}
            </span>
            <span>
              {o.providerName} · <strong>${o.totalCost.toFixed(2)}</strong>
              <span className="muted">{unitPriceLabel(o, unit)}</span>
            </span>
          </button>
        ))}
        {!opts.length && <p className="muted">No matching products — try scanning the UPC.</p>}
      </div>
      <button className="chip" onClick={onClose}>
        close
      </button>
    </div>
  );
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
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [nonce, setNonce] = useState(0);
  const { data: lists, error, loading } = useApi<ListRow[]>(
    () => api.get(`/shopping-lists${tab === 'archived' ? '?archived=true' : ''}`),
    [tab, nonce],
  );
  const { data: providers } = useApi<ProviderRow[]>(() => api.get('/providers'), []);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<ListDetail>();
  const [options, setOptions] = useState<ItemWithOptions[]>();
  const [build, setBuild] = useState<BuildResult>();
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState<string>();
  const [scanItemId, setScanItemId] = useState<string>();
  const [priceMsg, setPriceMsg] = useState<string>();
  const [newItem, setNewItem] = useState('');
  const [addResults, setAddResults] = useState<{ id: string; name: string; baseUnit?: string | null }[]>();
  const [addSel, setAddSel] = useState<{ id: string; name: string; baseUnit?: string | null }>();
  const [addQty, setAddQty] = useState(1);
  const [addUnit, setAddUnit] = useState('EACH');
  const [swapItem, setSwapItem] = useState<ItemWithOptions>();
  const [editItemId, setEditItemId] = useState<string>();
  const [editQty, setEditQty] = useState(1);
  const [editUnit, setEditUnit] = useState('EACH');

  const refresh = () => setNonce((n) => n + 1);

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

  async function newAdHocList() {
    const now = new Date();
    const l = await api.post<ListRow>('/shopping-lists', {
      name: `Quick list ${now.getMonth() + 1}/${now.getDate()}`,
    });
    refresh();
    open(l.id);
  }

  async function archiveList(id: string, archived: boolean) {
    await api.post(`/shopping-lists/${id}/archive`, { archived });
    if (selected === id) setSelected(undefined);
    refresh();
  }

  // Autocomplete the add box against the item catalog.
  useEffect(() => {
    if (!newItem.trim() || addSel) {
      setAddResults(undefined);
      return;
    }
    const t = setTimeout(async () => {
      const hits = await api.get<{ id: string; name: string; baseUnit?: string | null }[]>(
        `/items?q=${encodeURIComponent(newItem.trim())}`,
      );
      setAddResults(hits.slice(0, 8));
    }, 200);
    return () => clearTimeout(t);
  }, [newItem, addSel]);

  function pickAddItem(hit: { id: string; name: string; baseUnit?: string | null }) {
    setAddSel(hit);
    setNewItem(hit.name);
    setAddUnit(defaultUnitFor(hit.baseUnit));
    setAddResults(undefined);
  }

  async function addOneOff() {
    if (!selected || !newItem.trim()) return;
    await api.post(`/shopping-lists/${selected}/items`, {
      name: (addSel?.name ?? newItem).trim(),
      quantity: addQty,
      unit: addUnit,
    });
    setNewItem('');
    setAddSel(undefined);
    setAddQty(1);
    setAddUnit('EACH');
    setDetail(await api.get<ListDetail>(`/shopping-lists/${selected}`));
    await loadOptions(selected);
  }

  async function deleteItem(itemId: string) {
    if (!selected) return;
    await api.del(`/shopping-lists/${selected}/items/${itemId}`);
    setDetail(await api.get<ListDetail>(`/shopping-lists/${selected}`));
    await loadOptions(selected);
    setBuild(undefined);
  }

  async function editItemAmount(itemId: string, quantity: number, unit: string) {
    if (!selected || !(quantity > 0)) return;
    await api.patch(`/shopping-lists/${selected}/items/${itemId}`, { quantity, unit });
    await loadOptions(selected);
    setDetail(await api.get<ListDetail>(`/shopping-lists/${selected}`));
    setBuild(undefined);
  }

  async function selectMode(mode: 'unit' | 'total', itemId?: string) {
    if (!selected) return;
    setBusy(true);
    try {
      const r = await api.post<{ selected: number; unpriced: number }>(
        `/shopping-lists/${selected}/auto-select`,
        { mode, ...(itemId ? { itemId } : {}) },
      );
      if (!itemId) {
        setPriceMsg(
          `Whole list → best ${mode === 'unit' ? 'unit price' : 'total'} (${r.selected} priced)` +
            (r.unpriced ? `, ${r.unpriced} unpriced.` : '.'),
        );
      }
      await loadOptions(selected);
      setBuild(undefined);
    } finally {
      setBusy(false);
    }
  }

  // Choosing an option substitutes the product AND remembers the brand as the org's preference.
  async function chooseOption(itemId: string, o: ItemOption) {
    if (!selected) return;
    await api.post(`/shopping-lists/${selected}/items/${itemId}/substitute`, { productId: o.productId });
    await loadOptions(selected);
    setBuild(undefined);
  }

  async function substituteByScan(itemId: string, code: string) {
    setScanItemId(undefined);
    if (!selected) return;
    try {
      const r = await api.post<{ updated: boolean; brand?: string | null; message?: string }>(
        `/shopping-lists/${selected}/items/${itemId}/substitute`,
        { upc: code.replace(/\D/g, '') },
      );
      setPriceMsg(r.message ?? (r.updated ? `Swapped to ${r.brand ?? 'that product'} — saved as your preference.` : 'Couldn’t match that scan.'));
      await loadOptions(selected);
      setBuild(undefined);
    } catch (e) {
      setPriceMsg(e instanceof Error ? e.message : String(e));
    }
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

      {!selected && (
        <>
          <div className="slot-tabs">
            <button
              className={`slot-tab ${tab === 'active' ? 'active' : ''}`}
              onClick={() => setTab('active')}
            >
              Active
            </button>
            <button
              className={`slot-tab ${tab === 'archived' ? 'active' : ''}`}
              onClick={() => setTab('archived')}
            >
              Archived
            </button>
          </div>
          {tab === 'active' && (
            <button className="btn btn-inline" onClick={newAdHocList}>
              ＋ New list
            </button>
          )}
          {tab === 'active' && <CouponsPanel />}
        </>
      )}

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}

      {!selected && (
        <ul className="card-list">
          {lists?.length === 0 && (
            <p className="muted">
              {tab === 'archived'
                ? 'No archived lists.'
                : 'No lists yet — tap ＋ New list, or “🛒 I\'m going to the grocery store” on the Plan tab.'}
            </p>
          )}
          {lists?.map((l) => (
            <li key={l.id} className="card card-row" onClick={() => open(l.id)}>
              <div className="card-main">
                <div className="card-title">{l.name ?? 'Shopping list'}</div>
                <div className="card-sub">
                  {l.status}
                  {l.coverageStart &&
                    l.coverageEnd &&
                    ` · ${new Date(l.coverageStart).getMonth() + 1}/${new Date(l.coverageStart).getDate()}–${new Date(l.coverageEnd).getMonth() + 1}/${new Date(l.coverageEnd).getDate()}`}
                </div>
              </div>
              <button
                className="btn-link"
                title={tab === 'archived' ? 'Restore to active' : 'Archive (hide from active)'}
                onClick={(e) => {
                  e.stopPropagation();
                  archiveList(l.id, tab !== 'archived');
                }}
              >
                {tab === 'archived' ? '↩︎' : '🗄️'}
              </button>
              <button
                className="entry-x"
                title="Delete list (unlocks its days)"
                onClick={async (e) => {
                  e.stopPropagation();
                  await api.del(`/shopping-lists/${l.id}`);
                  refresh();
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
          <div className="page-head">
            <button className="btn-link" onClick={() => setSelected(undefined)}>
              ← All lists
            </button>
            <button className="btn-link" onClick={() => archiveList(selected!, true)}>
              🗄️ Archive
            </button>
          </div>
          <h3>{detail.name ?? 'Shopping list'}</h3>

          <div className="add-card">
            <div className="search-row add-oneoff">
              <input
                placeholder="＋ Add an item — start typing…"
                value={newItem}
                onChange={(e) => {
                  setNewItem(e.target.value);
                  setAddSel(undefined);
                }}
                onKeyDown={(e) => e.key === 'Enter' && addSel && addOneOff()}
              />
            </div>
            {addResults && (
              <div className="autocomplete">
                {addResults.map((h) => (
                  <button key={h.id} className="autocomplete-row" onClick={() => pickAddItem(h)}>
                    {h.name}
                  </button>
                ))}
                {!addResults.some((h) => h.name.toLowerCase() === newItem.trim().toLowerCase()) && (
                  <button
                    className="autocomplete-row autocomplete-new"
                    onClick={() => pickAddItem({ id: '', name: newItem.trim(), baseUnit: null })}
                  >
                    ＋ add “{newItem.trim()}”
                  </button>
                )}
              </div>
            )}
            {addSel && (
              <div className="sheet-row add-amount-row">
                <input
                  className="sheet-input"
                  type="number"
                  min={0}
                  step="any"
                  value={addQty}
                  onChange={(e) => setAddQty(Number(e.target.value))}
                />
                <UnitSelect value={addUnit} onChange={setAddUnit} />
                <button className="btn btn-inline" onClick={addOneOff} disabled={addQty <= 0}>
                  Add
                </button>
              </div>
            )}
          </div>

          <div className="section-label">Whole list</div>
          <div className="chips">
            <button className="chip" disabled={busy} onClick={() => selectMode('total')}>
              💵 Best total (default)
            </button>
            <button className="chip" disabled={busy} onClick={() => selectMode('unit')}>
              ⚖️ Best unit price
            </button>
            <button className="chip active" disabled={busy} onClick={buildLists}>
              🧾 Build lists
            </button>
          </div>
          <p className="muted sheet-hint">
            Default is best total. Flip the whole list, or tap 💵/⚖️ on any item — handy for
            shelf-stable staples where the bigger pack wins per-unit.
          </p>
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
                      <button
                        className="btn-link card-sub"
                        title="Change the amount needed"
                        onClick={() => {
                          setEditItemId(editItemId === it.id ? undefined : it.id);
                          setEditQty(Number(it.quantityNeeded));
                          setEditUnit(it.unit);
                        }}
                      >
                        {formatImperial(Number(it.quantityNeeded), dimensionOf(it.unit as Unit))} ✏️
                      </button>
                    </div>
                    <div>
                      <button className="btn-link" onClick={() => opt && setSwapItem(opt)} disabled={!opt} title="Swap product">
                        🔀 swap
                      </button>{' '}
                      <button
                        className="btn-link"
                        onClick={() => setCapturing(capturing === it.id ? undefined : it.id)}
                      >
                        {capturing === it.id ? 'close' : '💲 price'}
                      </button>{' '}
                      <button className="entry-x" title="Remove from list" onClick={() => deleteItem(it.id)}>
                        ✕
                      </button>
                    </div>
                  </div>

                  {editItemId === it.id && (
                    <div className="sheet-row add-amount-row">
                      <input
                        className="sheet-input"
                        type="number"
                        min={0}
                        step="any"
                        value={editQty}
                        onChange={(e) => setEditQty(Number(e.target.value))}
                      />
                      <UnitSelect value={editUnit} onChange={setEditUnit} />
                      <button
                        className="btn btn-inline"
                        onClick={() => {
                          editItemAmount(it.id, editQty, editUnit);
                          setEditItemId(undefined);
                        }}
                        disabled={editQty <= 0}
                      >
                        Save
                      </button>
                    </div>
                  )}

                  {chosen ? (
                    <div className="chosen">
                      <span className="badge badge-ok">{chosen.providerName}</span>{' '}
                      {chosen.brand ? `${chosen.brand} · ` : ''}
                      {chosen.size ? `${chosen.size} · ` : ''}
                      <strong>${chosen.totalCost.toFixed(2)}</strong>
                      <span className="muted">{unitPriceLabel(chosen, it.unit)}</span>
                    </div>
                  ) : (
                    <div className="card-sub muted">No price yet — 💲 price</div>
                  )}

                  {opt?.preferredBrand && (
                    <div className="card-sub">
                      ⭐ preferred: <strong>{opt.preferredBrand}</strong>
                      {opt.preferredBrandUnavailable && (
                        <span className="badge badge-part"> not stocked — using cheapest</span>
                      )}
                    </div>
                  )}

                  {opt && opt.options.length > 1 && (
                    <div className="mode-chips">
                      <button
                        className={`mode-chip ${opt.mode === 'total' ? 'active' : ''}`}
                        disabled={busy}
                        onClick={() => selectMode('total', it.id)}
                      >
                        💵 total
                      </button>
                      <button
                        className={`mode-chip ${opt.mode === 'unit' ? 'active' : ''}`}
                        disabled={busy}
                        onClick={() => selectMode('unit', it.id)}
                      >
                        ⚖️ unit
                      </button>
                    </div>
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

      {swapItem && (
        <SwapModal
          item={swapItem}
          unit={swapItem.unit}
          onPick={(o) => {
            chooseOption(swapItem.itemId, o);
            setSwapItem(undefined);
          }}
          onScan={() => {
            setScanItemId(swapItem.itemId);
            setSwapItem(undefined);
          }}
          onClose={() => setSwapItem(undefined)}
        />
      )}

      {scanItemId && (
        <BarcodeScanner
          onDetected={(code) => substituteByScan(scanItemId, code)}
          onClose={() => setScanItemId(undefined)}
        />
      )}
    </section>
  );
}
