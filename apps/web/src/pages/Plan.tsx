import { useState } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';

interface EntryRow {
  id: string;
  date: string | null;
  slot: string;
  servingsPlanned: number;
  recipe: { id: string; name: string; externalRating?: number | null; complexity?: string | null };
}
interface PlanRow {
  id: string;
  name?: string | null;
  startDate: string;
  endDate: string;
  entries: EntryRow[];
}
interface RuleRow {
  id: string;
  kind: string;
  weekday?: number | null;
  dayOfMonth?: number | null;
  recipe: { name: string };
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RULE_LABEL: Record<string, string> = {
  RANDOM_WEEKLY: 'weekly · random day',
  RANDOM_MONTHLY: 'monthly · random day',
  DAILY: 'every day',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
};

function fmt(d: string) {
  const date = new Date(d);
  return `${DAY[date.getDay()]} ${date.getMonth() + 1}/${date.getDate()}`;
}

/** Multi-select chip grid of the next 21 days. */
function DatePicker({ onAssign }: { onAssign: (dates: string[]) => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const days = Array.from({ length: 21 }, (_, i) => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + i);
    return d;
  });
  return (
    <div className="assign-picker">
      <div className="date-grid">
        {days.map((d) => {
          const iso = d.toISOString();
          const on = selected.has(iso);
          return (
            <button
              key={iso}
              className={`chip ${on ? 'active' : ''}`}
              onClick={() => {
                const next = new Set(selected);
                if (on) next.delete(iso);
                else next.add(iso);
                setSelected(next);
              }}
            >
              {DAY[d.getDay()]} {d.getMonth() + 1}/{d.getDate()}
            </button>
          );
        })}
      </div>
      <button
        className="btn btn-inline"
        disabled={selected.size === 0}
        onClick={() => onAssign([...selected])}
      >
        Assign {selected.size || ''} day{selected.size === 1 ? '' : 's'}
      </button>
    </div>
  );
}

export function Plan() {
  const [nonce, setNonce] = useState(0);
  const { data, error, loading } = useApi<PlanRow[]>(() => api.get('/meal-plans'), [nonce]);
  const { data: rules } = useApi<RuleRow[]>(() => api.get('/meal-rules'), [nonce]);
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [assigning, setAssigning] = useState<string>(); // entryId being assigned

  const refresh = () => setNonce((n) => n + 1);

  async function generateWeek() {
    setBusy(true);
    setMsg(undefined);
    try {
      const plan = await api.post<PlanRow>('/meal-plans/generate', {});
      setMsg(`Planned ${plan.entries.length} dinners (repeats included).`);
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function generateList(planId: string) {
    const list = await api.post<{ items: unknown[] }>(`/meal-plans/${planId}/generate-list`);
    setMsg(`Shopping list created (${list.items.length} items). See the Shop tab.`);
  }

  async function applyRules(planId: string) {
    const res = await api.post<{ applied: number }>(`/meal-plans/${planId}/apply-rules`);
    setMsg(`Added ${res.applied} repeating meal(s).`);
    refresh();
  }

  async function assign(planId: string, entryId: string, dates: string[]) {
    await api.post(`/meal-plans/${planId}/entries/${entryId}/assign`, { dates });
    setAssigning(undefined);
    refresh();
  }

  async function removeEntry(planId: string, entryId: string) {
    await api.del(`/meal-plans/${planId}/entries/${entryId}`);
    refresh();
  }

  async function removePlan(planId: string) {
    await api.del(`/meal-plans/${planId}`);
    refresh();
  }

  async function removeRule(id: string) {
    await api.del(`/meal-rules/${id}`);
    refresh();
  }

  return (
    <section className="page">
      <div className="page-head">
        <h2>Meal plans</h2>
        <button className="btn btn-inline" disabled={busy} onClick={generateWeek}>
          {busy ? 'Planning…' : '✨ Generate week'}
        </button>
      </div>
      {msg && <p className="notice">{msg}</p>}
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}

      {rules && rules.length > 0 && (
        <div className="card rules-card">
          <div className="card-title">🔁 Repeats</div>
          <ul className="plan-entries">
            {rules.map((r) => (
              <li key={r.id}>
                <span className="plan-recipe">{r.recipe.name}</span>
                <span className="muted">
                  {RULE_LABEL[r.kind]}
                  {r.kind === 'WEEKLY' && r.weekday != null && ` (${DAY[r.weekday]})`}
                  {r.kind === 'MONTHLY' && r.dayOfMonth != null && ` (day ${r.dayOfMonth})`}
                </span>
                <button className="entry-x" onClick={() => removeRule(r.id)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data?.length === 0 && (
        <p className="muted">
          No plans yet — ✨ Generate a week, or stage recipes with ➕ Plan from the Recipes tab.
        </p>
      )}
      <ul className="card-list">
        {data?.map((p) => {
          const unassigned = p.entries.filter((e) => !e.date);
          const dated = p.entries
            .filter((e) => e.date)
            .sort((a, b) => a.date!.localeCompare(b.date!));
          return (
            <li key={p.id} className="card">
              <div className="page-head">
                <div className="card-title">{p.name ?? 'Meal plan'}</div>
                <button className="btn-link" onClick={() => removePlan(p.id)}>
                  delete
                </button>
              </div>

              {unassigned.length > 0 && (
                <>
                  <div className="section-label">Unassigned</div>
                  <ul className="plan-entries">
                    {unassigned.map((e) => (
                      <li key={e.id}>
                        <span className="plan-recipe">{e.recipe.name}</span>
                        <button
                          className="btn-link"
                          onClick={() => setAssigning(assigning === e.id ? undefined : e.id)}
                        >
                          {assigning === e.id ? 'cancel' : 'assign days'}
                        </button>
                        <button className="entry-x" onClick={() => removeEntry(p.id, e.id)}>
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                  {assigning && unassigned.some((e) => e.id === assigning) && (
                    <DatePicker onAssign={(dates) => assign(p.id, assigning, dates)} />
                  )}
                </>
              )}

              {dated.length > 0 && (
                <ul className="plan-entries">
                  {dated.map((e) => (
                    <li key={e.id}>
                      <span className="plan-day">{fmt(e.date!)}</span>
                      <span className="plan-recipe">{e.recipe.name}</span>
                      {e.recipe.externalRating != null && (
                        <span className="stars"> ★{e.recipe.externalRating.toFixed(1)}</span>
                      )}
                      <button className="entry-x" onClick={() => removeEntry(p.id, e.id)}>
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="btn-row">
                <button className="btn" onClick={() => generateList(p.id)}>
                  🛒 Shopping list
                </button>
                <button className="btn btn-alt" onClick={() => applyRules(p.id)}>
                  🔁 Apply repeats
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
