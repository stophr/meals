import { useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  MouseSensor,
  TouchSensor,
} from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';

interface QueueEntry {
  id: string;
  mealPlanId: string;
  date: string | null;
  servingsPlanned: number;
  locked?: boolean;
  recipe: { id: string; name: string; externalRating?: number | null; imageUrl?: string | null };
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
const BOARD_DAYS = 14;

const keyOf = (iso: string) => iso.slice(0, 10);

function boardDays(): { key: string; date: Date }[] {
  return Array.from({ length: BOARD_DAYS }, (_, i) => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + i);
    return { key: d.toISOString().slice(0, 10), date: d };
  });
}

// ---------------------------------------------------------------------------

function MealTile({
  entry,
  onRemove,
  onDuplicate,
}: {
  entry: QueueEntry;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: entry.id,
    disabled: entry.locked,
  });
  return (
    <div
      ref={setNodeRef}
      className={`tile ${entry.locked ? 'tile-locked' : ''} ${isDragging ? 'tile-dragging' : ''}`}
      {...listeners}
      {...attributes}
    >
      {entry.recipe.imageUrl ? (
        <img className="tile-img" src={entry.recipe.imageUrl} alt="" draggable={false} />
      ) : (
        <div className="tile-img tile-img-fallback">{entry.recipe.name.slice(0, 1)}</div>
      )}
      <div className="tile-body">
        <div className="tile-name">{entry.recipe.name}</div>
        {entry.recipe.externalRating != null && (
          <div className="stars">★{entry.recipe.externalRating.toFixed(1)}</div>
        )}
      </div>
      {entry.locked ? (
        <span className="tile-lock" title="Locked — a shopping list bought for this day">
          🔒
        </span>
      ) : (
        <div className="tile-actions">
          <button
            className="tile-btn"
            title="Duplicate (drag the copy to another day)"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate();
            }}
          >
            ⧉
          </button>
          <button
            className="tile-btn tile-x"
            title="Remove"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

function TileGhost({ entry }: { entry: QueueEntry }) {
  return (
    <div className="tile tile-ghost">
      {entry.recipe.imageUrl ? (
        <img className="tile-img" src={entry.recipe.imageUrl} alt="" />
      ) : (
        <div className="tile-img tile-img-fallback">{entry.recipe.name.slice(0, 1)}</div>
      )}
      <div className="tile-body">
        <div className="tile-name">{entry.recipe.name}</div>
      </div>
    </div>
  );
}

function DayLane({
  dayKey,
  date,
  entries,
  locked,
  children,
}: {
  dayKey: string;
  date: Date;
  entries: QueueEntry[];
  locked: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${dayKey}`, disabled: locked });
  const today = new Date().toISOString().slice(0, 10) === dayKey;
  return (
    <div
      ref={setNodeRef}
      className={`lane ${locked ? 'lane-locked' : ''} ${isOver ? 'lane-over' : ''} ${today ? 'lane-today' : ''}`}
    >
      <div className="lane-head">
        <span className="lane-day">
          {today ? 'Today' : DAY[date.getDay()]}
          <span className="lane-date"> {date.getMonth() + 1}/{date.getDate()}</span>
        </span>
        {locked && <span title="Shopped for — locked">🔒</span>}
      </div>
      {entries.length === 0 && !locked && <div className="lane-empty">drop a meal here</div>}
      {children}
    </div>
  );
}

function UnassignedShelf({ entries, children }: { entries: QueueEntry[]; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'unassigned' });
  return (
    <div ref={setNodeRef} className={`shelf ${isOver ? 'lane-over' : ''}`}>
      <div className="section-label">Unassigned — drag onto a day</div>
      {entries.length === 0 && <div className="lane-empty">stage recipes with ➕ Plan, or drag a tile here to unschedule</div>}
      <div className="shelf-row">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Plan() {
  const [nonce, setNonce] = useState(0);
  const { data: queue, error, loading } = useApi<QueueData>(() => api.get('/queue'), [nonce]);
  const { data: rules } = useApi<RuleRow[]>(() => api.get('/meal-rules'), [nonce]);
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [shopOpen, setShopOpen] = useState(false);
  const [horizon, setHorizon] = useState(7);
  const [dragging, setDragging] = useState<QueueEntry>();

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
  );

  const refresh = () => setNonce((n) => n + 1);
  const lockedKeys = useMemo(() => new Set(queue?.lockedDayKeys ?? []), [queue]);
  const byDay = useMemo(() => {
    const m = new Map<string, QueueEntry[]>();
    for (const e of queue?.upcoming ?? []) {
      const k = keyOf(e.date!);
      const list = m.get(k);
      if (list) list.push(e);
      else m.set(k, [e]);
    }
    return m;
  }, [queue]);
  const allEntries = useMemo(
    () => [...(queue?.unassigned ?? []), ...(queue?.upcoming ?? [])],
    [queue],
  );
  const later = (queue?.upcoming ?? []).filter(
    (e) => keyOf(e.date!) > boardDays()[BOARD_DAYS - 1]!.key,
  );

  const run = async (fn: () => Promise<void>) => {
    setMsg(undefined);
    try {
      await fn();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  function onDragStart(ev: DragStartEvent) {
    setDragging(allEntries.find((e) => e.id === ev.active.id));
  }

  async function onDragEnd(ev: DragEndEvent) {
    const entry = allEntries.find((e) => e.id === ev.active.id);
    setDragging(undefined);
    const over = ev.over?.id;
    if (!entry || over == null) return;
    let date: string | null;
    if (over === 'unassigned') {
      if (!entry.date) return;
      date = null;
    } else {
      const k = String(over).replace(/^day:/, '');
      if (entry.date && keyOf(entry.date) === k) return;
      date = `${k}T12:00:00.000Z`;
    }
    await run(async () => {
      await api.patch(`/meal-plans/${entry.mealPlanId}/entries/${entry.id}`, { date });
      refresh();
    });
  }

  async function remove(e: QueueEntry) {
    await run(async () => {
      await api.del(`/meal-plans/${e.mealPlanId}/entries/${e.id}`);
      refresh();
    });
  }

  async function duplicate(e: QueueEntry) {
    await run(async () => {
      await api.post(`/meal-plans/${e.mealPlanId}/entries`, {
        recipeId: e.recipe.id,
        servingsPlanned: e.servingsPlanned,
      });
      setMsg(`Duplicated "${e.recipe.name}" to Unassigned — drag it onto a day.`);
      refresh();
    });
  }

  async function fillDays() {
    setBusy(true);
    await run(async () => {
      const plan = await api.post<{ entries: unknown[] }>('/meal-plans/generate', { days: 7 });
      setMsg(`Queued meals — ${plan.entries.length} scheduled over the next 7 days.`);
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
        `List "${list.name}": ${list.items.length} items for ${list.lockedMeals} meal(s). Days locked — optimize in Shop.`,
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

      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <UnassignedShelf entries={queue?.unassigned ?? []}>
          {(queue?.unassigned ?? []).map((e) => (
            <MealTile key={e.id} entry={e} onRemove={() => remove(e)} onDuplicate={() => duplicate(e)} />
          ))}
        </UnassignedShelf>

        <div className="board">
          {boardDays().map(({ key, date }) => (
            <DayLane
              key={key}
              dayKey={key}
              date={date}
              locked={lockedKeys.has(key)}
              entries={byDay.get(key) ?? []}
            >
              {(byDay.get(key) ?? []).map((e) => (
                <MealTile key={e.id} entry={e} onRemove={() => remove(e)} onDuplicate={() => duplicate(e)} />
              ))}
            </DayLane>
          ))}
        </div>

        {later.length > 0 && (
          <>
            <div className="section-label">Later</div>
            {later.map((e) => (
              <div key={e.id} className="tile">
                <div className="tile-body">
                  <div className="tile-name">
                    {keyOf(e.date!)} · {e.recipe.name}
                  </div>
                </div>
                {!e.locked && (
                  <button className="tile-btn tile-x" onClick={() => remove(e)}>
                    ✕
                  </button>
                )}
              </div>
            ))}
          </>
        )}

        <DragOverlay>{dragging ? <TileGhost entry={dragging} /> : null}</DragOverlay>
      </DndContext>
    </section>
  );
}
