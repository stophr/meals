import { useEffect, useState } from 'react';
import type { OptimizationResult } from '@meals/shared';
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

// Per-item store search deep links — open the item on the store's own site/app on mobile.
const STORE_LINKS: { label: string; url: (q: string) => string }[] = [
  { label: '🏬 Costco', url: (q) => `https://www.costco.com/CatalogSearch?keyword=${encodeURIComponent(q)}` },
  { label: '🔴 Fry’s', url: (q) => `https://www.frysfood.com/search?query=${encodeURIComponent(q)}` },
  { label: '🛒 Walmart', url: (q) => `https://www.walmart.com/search?q=${encodeURIComponent(q)}` },
];

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
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!providerId || !price) return;
    setBusy(true);
    try {
      await api.post(`/providers/${providerId}/quick-price`, {
        canonicalItemId: item.canonicalItemId,
        price: Number(price),
        size: size.trim() || undefined,
      });
      const store = providers.find((p) => p.id === providerId)?.name ?? 'store';
      onSaved(`Saved $${Number(price).toFixed(2)} for ${item.canonicalItem.name} at ${store}.`);
      setPrice('');
      setSize('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="price-capture">
      <div className="store-links">
        {STORE_LINKS.map((s) => (
          <a
            key={s.label}
            className="store-link"
            href={s.url(item.canonicalItem.name)}
            target="_blank"
            rel="noreferrer"
          >
            {s.label}
          </a>
        ))}
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
          className="price-input"
          type="number"
          inputMode="decimal"
          placeholder="$ price"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
        <input
          className="size-input"
          placeholder="size?"
          value={size}
          onChange={(e) => setSize(e.target.value)}
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
  const [result, setResult] = useState<OptimizationResult>();
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState<string>();
  const [priceMsg, setPriceMsg] = useState<string>();

  async function open(id: string) {
    setSelected(id);
    setResult(undefined);
    setDetail(await api.get<ListDetail>(`/shopping-lists/${id}`));
  }

  async function optimize() {
    if (!selected) return;
    setBusy(true);
    try {
      setResult(await api.post<OptimizationResult>(`/shopping-lists/${selected}/optimize`));
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
          <button className="btn" disabled={busy} onClick={optimize}>
            {busy ? 'Optimizing…' : 'Optimize (time vs savings)'}
          </button>

          {result && (
            <div className="options">
              {result.options.map((o, i) => (
                <div key={o.strategy} className={`option ${i === result.recommendedIndex ? 'recommended' : ''}`}>
                  <div className="option-head">
                    <strong>{o.strategy}</strong>
                    {i === result.recommendedIndex && <span className="badge">recommended</span>}
                  </div>
                  <div className="option-stats">
                    ${o.totalMoney.toFixed(2)} · {o.totalTimeMinutes} min ·{' '}
                    {o.storeSubtotals.length} store(s) · saves ${o.savingsVsBaseline.toFixed(2)}
                  </div>
                  <ul className="store-list">
                    {o.storeSubtotals.map((s) => (
                      <li key={s.providerId}>
                        {s.name}: ${s.itemCost.toFixed(2)} ({s.travelMinutes} min)
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {priceMsg && <p className="notice">{priceMsg}</p>}
          <ul className="card-list">
            {detail.items.map((it) => (
              <li key={it.id} className="card">
                <div className="page-head">
                  <div>
                    <div className="card-title">{it.canonicalItem.name}</div>
                    <div className="card-sub">
                      {Number(it.quantityNeeded).toFixed(0)} {it.unit.toLowerCase()}
                      {it.estimatedPrice ? ` · ~$${Number(it.estimatedPrice).toFixed(2)}` : ''}
                    </div>
                  </div>
                  <button
                    className="btn-link"
                    onClick={() => setCapturing(capturing === it.id ? undefined : it.id)}
                  >
                    {capturing === it.id ? 'close' : '💲 check price'}
                  </button>
                </div>
                {capturing === it.id && (
                  <PriceCapture item={it} providers={providers ?? []} onSaved={setPriceMsg} />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
