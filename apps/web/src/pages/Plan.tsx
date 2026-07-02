import { useState } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';

interface QueueEntry {
  id: string;
  mealPlanId: string;
  date: string | null;
  servingsPlanned: number;
  locked?: boolean;
  recipe: { id: string; name: string; externalRating?: number | null };
}
interface QueueData {
  unassigned: QueueEntry[];
  upcoming: QueueEntry[];
  lockedDayKeys: string[];
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
const HORIZONS = [3, 5, 7, 10, 14];

function fmt(d: string) {
  const date = new Date(d);
  return `${DAY[date.getDay()]} ${date.getMonth() + 1}/${date.getDate()}`;
}

/** Multi-select chip grid of the next 21 days; locked days disabled. */
function DatePicker({
  lockedKeys,
  onAssign,
}: {
  lockedKeys: Set<string>;
  onAssign: (dates: string[]) => void;
}) {
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
          const key = iso.slice(0, 10);
          const locked = lockedKeys.has(key);
          const on = selected.has(iso);
          return (
            <button
              key={iso}
              disabled={locked}
              title={locked ? 'Locked — already shopped for' : undefined}
              className={`chip ${on ? 'active' : ''} ${locked ? 'chip-locked' : ''}`}
              onClick={() => {
                const next = new Set(selected);
                if (on) next.delete(iso);
                else next.add(iso);
                setSelected(next);
              }}
            >
              {locked ? '🔒' : ''}
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
  const { data: queue, error, loading } = useApi<QueueData>(() => api.get('/queue'), [nonce]);
  const { data: rules } = useApi<RuleRow[]>(() => api.get('/meal-rules'), [nonce]);
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [assigning, setAssigning] = useState<string>();
  const [shopOpen, setShopOpen] = useState(false);
  const [horizon, setHorizon] = useState(7);

  const refresh = () => setNonce((n) => n + 1);
  const lockedKeys = new Set(queue?.lockedDayKeys ?? []);

  const run = async (fn: () => Promise<void>) => {
    setMsg(undefined);
    try {
      await fn();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  async function fillDays() {
    setBusy(true);
    await run(async () => {
      const plan = await api.post<{ entries: unknown[] }>('/meal-plans/generate', { days: 7 });
      setMsg(`Queued ${plan.entries.length} meals over the next 7 days (repeats included).`);
      refresh();
    });
    setBusy(false);
  }

  async function goShopping() {
    setBusy(true);
    await run(async () => {
      const list = await api.post<{ items: unknown[]; lockedMeals: number; name?: string }>(
        '/shopping-lists/from-queue',
        { days: horizon },
      );
      setShopOpen(false);
      setMsg(
        `List "${list.name}" built: ${list.items.length} items for ${list.lockedMeals} meal(s). ` +
          `Those days are now locked. Optimize stores in the Shop tab.`,
      );
      refresh();
    });
    setBusy(false);
  }

  return (
    <section className="page">
      <div className="page-head">
        <h2>Meal queue</h2>
        <button className="btn-link" disabled={busy} onClick={fillDays}>
          ✨ Fill 7 days
        </button>
      </div>

      <button className="btn shop-cta" onClick={() => setShopOpen(!shopOpen)}>
        🛒 I'm going to the grocery store
      </button>
      {shopOpen && (
        <div className="card shop-panel">
          <div className="section-label">Shop how many days out?</div>
          <div className="chips">
            {HORIZONS.map((h) => (
              <button
                key={h}
                className={`chip ${horizon === h ? 'active' : ''}`}
                onClick={() => setHorizon(h)}
              >
                {h} days
              </button>
            ))}
          </div>
          <button className="btn btn-inline" disabled={busy} onClick={goShopping}>
            Build list for next {horizon} days
          </button>
        </div>
      )}

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
                <button
                  className="entry-x"
                  onClick={() => run(async () => (await api.del(`/meal-rules/${r.id}`), refresh()))}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {queue && queue.unassigned.length > 0 && (
        <div className="card">
          <div className="section-label">Unassigned — pick days</div>
          <ul className="plan-entries">
            {queue.unassigned.map((e) => (
              <li key={e.id}>
                <span className="plan-recipe">{e.recipe.name}</span>
                <button
                  className="btn-link"
                  onClick={() => setAssigning(assigning === e.id ? undefined : e.id)}
                >
                  {assigning === e.id ? 'cancel' : 'assign days'}
                </button>
                <button
                  className="entry-x"
                  onClick={() =>
                    run(async () => (await api.del(`/meal-plans/${e.mealPlanId}/entries/${e.id}`), refresh()))
                  }
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          {assigning &&
            (() => {
              const entry = queue.unassigned.find((e) => e.id === assigning);
              return entry ? (
                <DatePicker
                  lockedKeys={lockedKeys}
                  onAssign={(dates) =>
                    run(async () => {
                      await api.post(`/meal-plans/${entry.mealPlanId}/entries/${entry.id}/assign`, { dates });
                      setAssigning(undefined);
                      refresh();
                    })
                  }
                />
              ) : null;
            })()}
        </div>
      )}

      <div className="section-label">Coming up</div>
      {queue?.upcoming.length === 0 && (
        <p className="muted">
          Queue is empty — ✨ Fill 7 days, or stage recipes with ➕ Plan from the Recipes tab.
        </p>
      )}
      <ul className="plan-entries queue-list">
        {queue?.upcoming.map((e) => (
          <li key={e.id} className={e.locked ? 'locked-row' : ''}>
            <span className="plan-day">{fmt(e.date!)}</span>
            <span className="plan-recipe">{e.recipe.name}</span>
            {e.recipe.externalRating != null && (
              <span className="stars"> ★{e.recipe.externalRating.toFixed(1)}</span>
            )}
            {e.locked ? (
              <span title="Locked — a shopping list bought for this day">🔒</span>
            ) : (
              <button
                className="entry-x"
                onClick={() =>
                  run(async () => (await api.del(`/meal-plans/${e.mealPlanId}/entries/${e.id}`), refresh()))
                }
              >
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
