import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';

interface RecipeRow {
  id: string;
  name: string;
  servings: number;
  prepMinutes?: number | null;
  ingredients: { id: string }[];
}

export function Recipes() {
  const { data, error, loading } = useApi<RecipeRow[]>(() => api.get('/recipes'), []);

  return (
    <section className="page">
      <h2>Recipes</h2>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {data?.length === 0 && <p className="muted">No recipes yet.</p>}
      <ul className="card-list">
        {data?.map((r) => (
          <li key={r.id} className="card">
            <div className="card-title">{r.name}</div>
            <div className="card-sub">
              {r.ingredients.length} ingredients · serves {r.servings}
              {r.prepMinutes ? ` · ${r.prepMinutes} min` : ''}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
