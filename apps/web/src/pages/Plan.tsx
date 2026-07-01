import { useState } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';

interface PlanRow {
  id: string;
  name?: string | null;
  startDate: string;
  endDate: string;
  entries: { id: string; recipe: { name: string } }[];
}

export function Plan() {
  const [nonce, setNonce] = useState(0);
  const { data, error, loading } = useApi<PlanRow[]>(() => api.get('/meal-plans'), [nonce]);
  const [msg, setMsg] = useState<string>();

  async function generate(planId: string) {
    setMsg(undefined);
    try {
      const list = await api.post<{ id: string; items: unknown[] }>(`/meal-plans/${planId}/generate-list`);
      setMsg(`Generated a shopping list with ${list.items.length} items. Open the Shop tab.`);
      setNonce((n) => n + 1);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="page">
      <h2>Meal plans</h2>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {msg && <p className="notice">{msg}</p>}
      {data?.length === 0 && <p className="muted">No plans yet.</p>}
      <ul className="card-list">
        {data?.map((p) => (
          <li key={p.id} className="card">
            <div className="card-title">{p.name ?? 'Meal plan'}</div>
            <div className="card-sub">
              {new Date(p.startDate).toLocaleDateString()} – {new Date(p.endDate).toLocaleDateString()} ·{' '}
              {p.entries.length} meals
            </div>
            <button className="btn" onClick={() => generate(p.id)}>
              Generate shopping list
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
