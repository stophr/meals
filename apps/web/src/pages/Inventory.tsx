import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';

interface Lot {
  id: string;
  quantity: string;
  unit: string;
  expiresAt?: string | null;
  canonicalItem: { name: string };
}

export function Inventory() {
  const { data, error, loading } = useApi<Lot[]>(() => api.get('/inventory'), []);

  return (
    <section className="page">
      <h2>Pantry</h2>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {data?.length === 0 && <p className="muted">Nothing in the pantry.</p>}
      <ul className="card-list">
        {data?.map((l) => (
          <li key={l.id} className="card">
            <div className="card-title">{l.canonicalItem.name}</div>
            <div className="card-sub">
              {Number(l.quantity)} {l.unit.toLowerCase()}
              {l.expiresAt ? ` · expires ${new Date(l.expiresAt).toLocaleDateString()}` : ''}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
