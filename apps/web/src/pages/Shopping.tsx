import { useState } from 'react';
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
    quantityNeeded: string;
    unit: string;
    estimatedPrice?: string | null;
    canonicalItem: { name: string };
  }[];
}

export function Shopping() {
  const { data: lists, error, loading } = useApi<ListRow[]>(() => api.get('/shopping-lists'), []);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<ListDetail>();
  const [result, setResult] = useState<OptimizationResult>();
  const [busy, setBusy] = useState(false);

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

          <ul className="card-list">
            {detail.items.map((it) => (
              <li key={it.id} className="card">
                <div className="card-title">{it.canonicalItem.name}</div>
                <div className="card-sub">
                  {Number(it.quantityNeeded).toFixed(0)} {it.unit.toLowerCase()}
                  {it.estimatedPrice ? ` · ~$${Number(it.estimatedPrice).toFixed(2)}` : ''}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
