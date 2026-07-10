import { useCallback, useEffect, useState } from 'react';
import type { RecipeCoverage } from '@meals/shared';
import { imperializeText, formatImperial, dimensionOf } from '@meals/shared';
import type { Unit } from '@meals/shared';
import { api } from '../lib/api.js';

interface RecipeRow {
  id: string;
  name: string;
  servings: number;
  prepMinutes?: number | null;
  imageUrl?: string | null;
  cuisine?: string | null;
  category?: string | null;
  tags: string[];
  complexity?: 'EASY' | 'MEDIUM' | 'HARD' | null;
  externalRating?: number | null;
  externalRatingCount?: number | null;
  isFavorite: boolean;
  isShared?: boolean;
  canShare?: boolean;
  timesCooked: number;
  sourceName?: string | null;
  instructions?: string | null;
  estCostPerServing?: string | null;
  estCostTotal?: string | null;
  costCoverage?: number | null;
  promoIngredients?: number | null;
  cookTonightCost?: number | null;
  nutrition?: {
    perServing: Partial<Record<'calories' | 'proteinG' | 'carbsG' | 'sugarG' | 'fiberG' | 'fatG' | 'satFatG' | 'sodiumMg', number>>;
    covered: number;
    required: number;
  } | null;
  ingredients: {
    id: string;
    freeText?: string | null;
    quantity: string;
    unit: string | null;
    baseQuantity?: string | null;
    optional: boolean;
    canonicalItemId?: string | null;
    canonicalItem?: { name: string } | null;
    substitutedFrom?: string | null;
    substitutionId?: string | null;
    originalCanonicalItemId?: string | null;
  }[];
  coverage: RecipeCoverage;
  caloriesPerServing?: number | null;
  dietFitPct?: number | null;
}

interface Meta {
  cuisines: string[];
  categories: string[];
  tags: string[];
}

interface DiscoverResult {
  externalId: string;
  name: string;
  category?: string;
  cuisine?: string;
  imageUrl?: string;
  alreadyImported: boolean;
}

const SORTS = [
  { v: 'name', label: 'A–Z' },
  { v: 'rating', label: '★ Rating' },
  { v: 'popular', label: 'Popular' },
  { v: 'newest', label: 'Newest' },
  { v: 'complexity', label: 'Easiest' },
  { v: 'cheapest', label: '💰 Cheapest' },
] as const;

function Stars({ rating, count }: { rating?: number | null; count?: number | null }) {
  if (rating == null) return null;
  const full = Math.round(rating);
  return (
    <span className="stars" title={`${rating.toFixed(1)} from ${count ?? '?'} ratings`}>
      {'★'.repeat(full)}
      {'☆'.repeat(5 - full)}
      <span className="stars-num"> {rating.toFixed(1)}</span>
    </span>
  );
}

function CoverageBadge({ c }: { c: RecipeCoverage }) {
  if (c.cookable) return <span className="badge badge-ok">🧺 cook now</span>;
  if (c.requiredCount > 0 && c.satisfiedCount > 0)
    return (
      <span className="badge badge-part">
        🧺 {c.satisfiedCount}/{c.requiredCount} in pantry
      </span>
    );
  return null;
}

function NutritionPanel({ n }: { n: NonNullable<RecipeRow['nutrition']> }) {
  const ps = n.perServing;
  if (ps.calories == null && ps.proteinG == null && ps.carbsG == null && ps.fatG == null) return null;
  const macro = (label: string, v?: number) =>
    v == null ? null : (
      <span className="nutri-item">
        <b>{Math.round(v)}g</b> {label}
      </span>
    );
  return (
    <div className="nutri">
      <div className="nutri-head">
        Nutrition <span className="muted">per serving · {n.covered}/{n.required} ingredients</span>
      </div>
      <div className="nutri-row">
        {ps.calories != null && (
          <span className="nutri-item">
            <b>{Math.round(ps.calories)}</b> cal
          </span>
        )}
        {macro('protein', ps.proteinG)}
        {macro('carbs', ps.carbsG)}
        {macro('fat', ps.fatG)}
        {ps.fiberG != null && macro('fiber', ps.fiberG)}
        {ps.sodiumMg != null && (
          <span className="nutri-item">
            <b>{Math.round(ps.sodiumMg)}mg</b> sodium
          </span>
        )}
      </div>
    </div>
  );
}

/** Inline search to pick a replacement ingredient for a substitution. */
function SubstitutePicker({ onPick }: { onPick: (itemId: string) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ id: string; name: string }[]>();
  useEffect(() => {
    if (!q.trim()) {
      setHits(undefined);
      return;
    }
    const t = setTimeout(async () => {
      const r = await api.get<{ id: string; name: string }[]>(`/items?q=${encodeURIComponent(q.trim())}`);
      setHits(r.slice(0, 6));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="sub-picker">
      <input autoFocus placeholder="substitute with…" value={q} onChange={(e) => setQ(e.target.value)} />
      {hits?.map((h) => (
        <button key={h.id} className="autocomplete-row" onClick={() => onPick(h.id)}>
          {h.name}
        </button>
      ))}
    </div>
  );
}

export function Recipes() {
  const [items, setItems] = useState<RecipeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [meta, setMeta] = useState<Meta>({ cuisines: [], categories: [], tags: [] });
  const [q, setQ] = useState('');
  const [cuisine, setCuisine] = useState('');
  const [category, setCategory] = useState('');
  const [complexity, setComplexity] = useState('');
  const [favOnly, setFavOnly] = useState(false);
  const [cookable, setCookable] = useState(false);
  const [sort, setSort] = useState<string>('name');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [suggested, setSuggested] = useState<RecipeRow[]>([]);
  const [suggestReason, setSuggestReason] = useState<'taste' | 'popular'>();
  const [detail, setDetail] = useState<RecipeRow>();
  const [subFor, setSubFor] = useState<string>();
  const [mode, setMode] = useState<'catalog' | 'discover'>('catalog');
  const [discoverQ, setDiscoverQ] = useState('');
  const [discoverResults, setDiscoverResults] = useState<DiscoverResult[]>();
  const [busyId, setBusyId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [repeatKind, setRepeatKind] = useState('RANDOM_WEEKLY');
  const [repeatDay, setRepeatDay] = useState(2);
  const [repeatDom, setRepeatDom] = useState(15);

  // Staged = this recipe has an unassigned (template) entry in the queue. The button is a
  // toggle: stage on first tap, un-stage on the second.
  const [staged, setStaged] = useState<{ entryId: string; planId: string }>();

  async function toggleStage(r: RecipeRow) {
    if (staged) {
      await api.del(`/meal-plans/${staged.planId}/entries/${staged.entryId}`);
      setStaged(undefined);
    } else {
      const res = await api.post<{ planId: string; entry: { id: string } }>('/meal-plans/stage', {
        recipeId: r.id,
      });
      setStaged({ entryId: res.entry.id, planId: res.planId });
    }
  }

  async function saveRepeat(r: RecipeRow) {
    await api.post('/meal-rules', {
      recipeId: r.id,
      kind: repeatKind,
      ...(repeatKind === 'WEEKLY' ? { weekday: repeatDay } : {}),
      ...(repeatKind === 'MONTHLY' ? { dayOfMonth: repeatDom } : {}),
    });
    setRepeatOpen(false);
    setNotice('Repeat saved — it lands in generated plans and “Apply repeats”.');
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (cuisine) params.set('cuisine', cuisine);
      if (category) params.set('category', category);
      if (complexity) params.set('complexity', complexity);
      if (favOnly) params.set('favorite', 'true');
      if (cookable) params.set('cookable', 'true');
      params.set('sort', sort);
      const res = await api.get<{ items: RecipeRow[]; total: number }>(`/recipes?${params}`);
      setItems(res.items);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [q, cuisine, category, complexity, favOnly, cookable, sort]);

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0); // debounce typing
    return () => clearTimeout(t);
  }, [load, q]);

  useEffect(() => {
    api.get<Meta>('/recipes/meta').then(setMeta).catch(() => {});
  }, [items.length]);

  const loadSuggested = useCallback(async () => {
    try {
      const res = await api.get<{ items: RecipeRow[]; reason: 'taste' | 'popular' }>(
        '/recipes/suggested?take=12',
      );
      setSuggested(res.items);
      setSuggestReason(res.reason);
    } catch {
      /* suggestions are best-effort; ignore */
    }
  }, []);
  useEffect(() => {
    loadSuggested();
  }, [loadSuggested]);

  async function toggleFavorite(r: RecipeRow) {
    const updated = await api.post<RecipeRow>(`/recipes/${r.id}/favorite`);
    setItems((xs) => xs.map((x) => (x.id === r.id ? { ...x, isFavorite: updated.isFavorite } : x)));
    setSuggested((xs) => xs.map((x) => (x.id === r.id ? { ...x, isFavorite: updated.isFavorite } : x)));
    if (detail?.id === r.id) setDetail({ ...detail, isFavorite: updated.isFavorite });
  }

  async function toggleShare() {
    if (!detail) return;
    const updated = await api.post<{ isShared: boolean }>(`/recipes/${detail.id}/share`, {
      shared: !detail.isShared,
    });
    setDetail({ ...detail, isShared: updated.isShared });
  }

  async function applySub(fromCanonicalItemId: string, toCanonicalItemId: string) {
    await api.post('/substitutions', { fromCanonicalItemId, toCanonicalItemId });
    setSubFor(undefined);
    if (detail) await openDetail(detail.id);
  }
  async function revertSub(subId: string) {
    await api.del(`/substitutions/${subId}`);
    if (detail) await openDetail(detail.id);
  }

  async function openDetail(id: string) {
    setStaged(undefined);
    setNotice(undefined);
    const [recipe, queue] = await Promise.all([
      api.get<RecipeRow>(`/recipes/${id}`),
      api
        .get<{ unassigned: { id: string; mealPlanId: string; recipe: { id: string } }[] }>('/queue')
        .catch(() => ({ unassigned: [] })),
    ]);
    const existing = queue.unassigned.find((e) => e.recipe.id === id);
    if (existing) setStaged({ entryId: existing.id, planId: existing.mealPlanId });
    setDetail(recipe);
  }

  async function cook(r: RecipeRow) {
    setBusyId(r.id);
    try {
      const res = await api.post<{
        consumed: { name: string }[];
        shortfalls: { name: string }[];
      }>(`/recipes/${r.id}/cook`, {});
      setNotice(
        res.shortfalls.length
          ? `Cooked! Pantry was short on: ${res.shortfalls.map((s) => s.name).join(', ')}`
          : 'Cooked! Pantry updated.',
      );
      await openDetail(r.id);
      await load();
    } finally {
      setBusyId(undefined);
    }
  }

  async function runDiscover() {
    if (!discoverQ.trim()) return;
    setDiscoverResults(undefined);
    const res = await api.get<{ results: DiscoverResult[] }>(
      `/recipes/discover?q=${encodeURIComponent(discoverQ.trim())}`,
    );
    setDiscoverResults(res.results);
  }

  async function ingest(r: DiscoverResult) {
    setBusyId(r.externalId);
    try {
      await api.post(`/recipes/discover/ingest`, { externalId: r.externalId });
      setDiscoverResults((xs) =>
        xs?.map((x) => (x.externalId === r.externalId ? { ...x, alreadyImported: true } : x)),
      );
      setNotice(`Added "${r.name}" to your catalog.`);
    } finally {
      setBusyId(undefined);
    }
  }

  async function importUrl() {
    const url = window.prompt('Paste a recipe page URL (most recipe sites work):');
    if (!url) return;
    try {
      const r = await api.post<RecipeRow & { duplicate?: boolean }>(`/recipes/import`, { url });
      setNotice(r.duplicate ? 'Already in your catalog.' : `Imported "${r.name}".`);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  // ---------- detail view ----------
  if (detail) {
    const c = detail.coverage;
    return (
      <section className="page">
        <button className="btn-link" onClick={() => setDetail(undefined)}>
          ← Recipes
        </button>
        {detail.imageUrl && <img className="detail-img" src={detail.imageUrl} alt="" />}
        <div className="detail-head">
          <h2>{detail.name}</h2>
          <button
            className={`fav-btn ${detail.isFavorite ? 'on' : ''}`}
            onClick={() => toggleFavorite(detail)}
            aria-label="favorite"
          >
            {detail.isFavorite ? '♥' : '♡'}
          </button>
        </div>
        {detail.canShare && (
          <button className="btn-link" onClick={toggleShare}>
            {detail.isShared ? '🌐 Shared to everyone — make private' : '🔒 Private to your org — share it'}
          </button>
        )}
        <div className="card-sub">
          <Stars rating={detail.externalRating} count={detail.externalRatingCount} />
          {detail.cuisine && ` · ${detail.cuisine}`}
          {detail.category && ` · ${detail.category}`}
          {detail.complexity && ` · ${detail.complexity.toLowerCase()}`}
          {detail.prepMinutes ? ` · ${detail.prepMinutes} min` : ''} · serves {detail.servings}
          {detail.timesCooked > 0 && ` · cooked ×${detail.timesCooked}`}
        </div>
        {detail.estCostTotal != null && (
          <div className="cost-line">
            💰 est. ${Number(detail.estCostTotal).toFixed(2)} total · $
            {Number(detail.estCostPerServing).toFixed(2)}/serving
            {detail.costCoverage != null && ` (${Math.round(detail.costCoverage * 100)}% of ingredients priced)`}
            {(detail.promoIngredients ?? 0) > 0 && ` · ${detail.promoIngredients} on promo 🔥`}
            {detail.cookTonightCost != null && detail.cookTonightCost < Number(detail.estCostTotal) && (
              <div className="cost-tonight">
                🧺 cook tonight for ~${detail.cookTonightCost.toFixed(2)} (pantry covers the rest)
              </div>
            )}
          </div>
        )}
        <div className="detail-badges">
          <CoverageBadge c={c} />
          {c.unlinkedCount > 0 && (
            <span className="badge">{c.unlinkedCount} ingredient(s) unverified</span>
          )}
        </div>
        {detail.nutrition && detail.nutrition.covered > 0 && <NutritionPanel n={detail.nutrition} />}
        {notice && <p className="notice">{notice}</p>}
        <div className="btn-row">
          <button className="btn" disabled={busyId === detail.id} onClick={() => cook(detail)}>
            {busyId === detail.id ? 'Cooking…' : '🍳 Cook this'}
          </button>
          <button
            className={staged ? 'btn' : 'btn btn-alt'}
            onClick={() => toggleStage(detail)}
          >
            {staged ? '✓ Staged' : '➕ Plan'}
          </button>
          <button className="btn btn-alt" onClick={() => setRepeatOpen(!repeatOpen)}>
            🔁 Repeat
          </button>
        </div>
        {repeatOpen && (
          <div className="repeat-form">
            <select value={repeatKind} onChange={(e) => setRepeatKind(e.target.value)}>
              <option value="RANDOM_WEEKLY">Weekly, random day</option>
              <option value="RANDOM_MONTHLY">Monthly, random day</option>
              <option value="DAILY">Every day</option>
              <option value="WEEKLY">Weekly on…</option>
              <option value="MONTHLY">Monthly on day…</option>
            </select>
            {repeatKind === 'WEEKLY' && (
              <select value={repeatDay} onChange={(e) => setRepeatDay(Number(e.target.value))}>
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            )}
            {repeatKind === 'MONTHLY' && (
              <input
                type="number"
                min={1}
                max={31}
                value={repeatDom}
                onChange={(e) => setRepeatDom(Number(e.target.value))}
              />
            )}
            <button className="btn btn-inline" onClick={() => saveRepeat(detail)}>
              Save repeat
            </button>
          </div>
        )}

        <h3>Ingredients</h3>
        <ul className="ing-list">
          {detail.ingredients.map((ing) => {
            const linked = !!ing.canonicalItemId;
            const missing = c.missing.some((m) => m.name === ing.canonicalItem?.name);
            const mark = !linked ? '·' : missing ? '✗' : '✓';
            const cls = !linked ? 'ing-unknown' : missing ? 'ing-missing' : 'ing-have';
            return (
              <li key={ing.id} className={cls}>
                <span className="ing-mark">{mark}</span>
                {ing.substitutedFrom ? (
                  <span>
                    🔄 {ing.canonicalItem?.name}{' '}
                    <span className="muted">(instead of {ing.substitutedFrom})</span>
                  </span>
                ) : ing.freeText ? (
                  imperializeText(ing.freeText)
                ) : (
                  `${formatImperial(Number(ing.baseQuantity ?? ing.quantity), ing.unit ? dimensionOf(ing.unit as Unit) : 'COUNT')} ${ing.canonicalItem?.name ?? ''}`
                )}
                {ing.optional && <em className="muted"> (optional)</em>}
                {linked &&
                  (ing.substitutionId ? (
                    <button
                      className="btn-link ing-sub"
                      title="Revert substitution"
                      onClick={() => revertSub(ing.substitutionId!)}
                    >
                      ↩︎
                    </button>
                  ) : (
                    <button
                      className="btn-link ing-sub"
                      title="Substitute this ingredient (org-wide)"
                      onClick={() => setSubFor(subFor === ing.id ? undefined : ing.id)}
                    >
                      🔄
                    </button>
                  ))}
                {subFor === ing.id && (
                  <SubstitutePicker
                    onPick={(toId) =>
                      applySub(ing.originalCanonicalItemId ?? ing.canonicalItemId!, toId)
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>

        {detail.instructions && (
          <>
            <h3>Instructions</h3>
            <p className="instructions">{detail.instructions}</p>
          </>
        )}
      </section>
    );
  }

  // ---------- discover view ----------
  if (mode === 'discover') {
    return (
      <section className="page">
        <button className="btn-link" onClick={() => setMode('catalog')}>
          ← My catalog
        </button>
        <h2>Find new recipes</h2>
        <div className="search-row">
          <input
            placeholder="Search the recipe database…"
            value={discoverQ}
            onChange={(e) => setDiscoverQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runDiscover()}
          />
          <button className="btn btn-inline" onClick={runDiscover}>
            Search
          </button>
        </div>
        {notice && <p className="notice">{notice}</p>}
        {discoverResults?.length === 0 && <p className="muted">No matches.</p>}
        <ul className="card-list">
          {discoverResults?.map((r) => (
            <li key={r.externalId} className="card card-row">
              {r.imageUrl && <img className="thumb" src={r.imageUrl} alt="" />}
              <div className="card-main">
                <div className="card-title">{r.name}</div>
                <div className="card-sub">
                  {[r.cuisine, r.category].filter(Boolean).join(' · ')}
                </div>
              </div>
              {r.alreadyImported ? (
                <span className="badge badge-ok">added</span>
              ) : (
                <button
                  className="btn btn-inline"
                  disabled={busyId === r.externalId}
                  onClick={() => ingest(r)}
                >
                  {busyId === r.externalId ? '…' : '+ Add'}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    );
  }

  // ---------- catalog view ----------
  return (
    <section className="page">
      <div className="page-head">
        <h2>Recipes</h2>
        <div>
          <button className="btn-link" onClick={importUrl}>
            + URL
          </button>{' '}
          <button className="btn-link" onClick={() => setMode('discover')}>
            🔎 Discover
          </button>
        </div>
      </div>

      <div className="search-row">
        <input
          placeholder="Search recipes or ingredients…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="chips">
        <button className={`chip ${favOnly ? 'active' : ''}`} onClick={() => setFavOnly(!favOnly)}>
          ♥ Favorites
        </button>
        <button
          className={`chip ${cookable ? 'active' : ''}`}
          onClick={() => setCookable(!cookable)}
        >
          🧺 Cook from pantry
        </button>
        <select className="chip" value={cuisine} onChange={(e) => setCuisine(e.target.value)}>
          <option value="">Cuisine</option>
          {meta.cuisines.map((c) => (
            <option key={c} value={c!}>
              {c}
            </option>
          ))}
        </select>
        <select className="chip" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Category</option>
          {meta.categories.map((c) => (
            <option key={c} value={c!}>
              {c}
            </option>
          ))}
        </select>
        <select
          className="chip"
          value={complexity}
          onChange={(e) => setComplexity(e.target.value)}
        >
          <option value="">Complexity</option>
          <option value="EASY">Easy</option>
          <option value="MEDIUM">Medium</option>
          <option value="HARD">Hard</option>
        </select>
        <select className="chip" value={sort} onChange={(e) => setSort(e.target.value)}>
          {SORTS.map((s) => (
            <option key={s.v} value={s.v}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {!q && !cuisine && !category && !complexity && !favOnly && !cookable && suggested.length > 0 && (
        <div className="suggest-shelf">
          <div className="suggest-head">
            <h3>{suggestReason === 'taste' ? '✨ Suggested for you' : '✨ Popular picks'}</h3>
            <span className="muted suggest-why">
              {suggestReason === 'taste'
                ? 'based on your favorites & plans'
                : 'well-loved — to get you started'}
            </span>
          </div>
          <div className="suggest-scroll">
            {suggested.map((r) => (
              <div key={r.id} className="suggest-card" onClick={() => openDetail(r.id)}>
                {r.imageUrl ? (
                  <img className="suggest-thumb" src={r.imageUrl} alt="" />
                ) : (
                  <div className="suggest-thumb placeholder">🍽️</div>
                )}
                <button
                  className={`suggest-fav ${r.isFavorite ? 'on' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFavorite(r);
                  }}
                  aria-label="favorite"
                >
                  {r.isFavorite ? '♥' : '♡'}
                </button>
                <div className="suggest-body">
                  <div className="suggest-name">{r.name}</div>
                  <div className="suggest-meta">
                    {r.coverage.cookable
                      ? '🧺 cook now'
                      : [
                          r.cuisine,
                          r.externalRating ? `★ ${r.externalRating.toFixed(1)}` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                  </div>
                  {r.caloriesPerServing != null && (
                    <div className="suggest-cal muted">
                      🎯 {r.caloriesPerServing} kcal{r.dietFitPct != null ? ` · ${r.dietFitPct}% of your day` : ''}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {notice && <p className="notice">{notice}</p>}
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && items.length === 0 && (
        <p className="muted">
          No recipes match. Try 🔎 Discover to search the recipe database, or + URL to import
          from any recipe site.
        </p>
      )}

      <ul className="card-list">
        {items.map((r) => (
          <li key={r.id} className="card card-row" onClick={() => openDetail(r.id)}>
            {r.imageUrl && <img className="thumb" src={r.imageUrl} alt="" />}
            <div className="card-main">
              <div className="card-title">{r.name}</div>
              <div className="card-sub">
                <Stars rating={r.externalRating} count={r.externalRatingCount} />
                {r.estCostPerServing != null && (
                  <span className="cost-badge">
                    ${Number(r.estCostPerServing).toFixed(2)}/serv
                    {(r.promoIngredients ?? 0) > 0 && ' 🔥'}
                  </span>
                )}
                {r.cuisine && ` ${r.cuisine}`}
                {r.complexity && ` · ${r.complexity.toLowerCase()}`}
                {r.prepMinutes ? ` · ${r.prepMinutes}m` : ''}
              </div>
              <div className="detail-badges">
                <CoverageBadge c={r.coverage} />
              </div>
            </div>
            <button
              className={`fav-btn ${r.isFavorite ? 'on' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleFavorite(r);
              }}
              aria-label="favorite"
            >
              {r.isFavorite ? '♥' : '♡'}
            </button>
          </li>
        ))}
      </ul>
      {total > items.length && (
        <p className="muted">
          Showing {items.length} of {total}.
        </p>
      )}
    </section>
  );
}
