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
  slot: string;
  servingsPlanned: number;
  locked?: boolean;
  recipe: {
    id: string;
    name: string;
    externalRating?: number | null;
    imageUrl?: string | null;
    servings?: number | null;
  };
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

const SLOTS = [
  { id: 'breakfast', label: '🍳 Bfast' },
  { id: 'morning-snack', label: '🥐 AM' },
  { id: 'lunch', label: '🥪 Lunch' },
  { id: 'afternoon-snack', label: '🍎 PM' },
  { id: 'dinner', label: '🍽 Dinner' },
];

const keyOf = (iso: string) => iso.slice(0, 10);

function localDayKey(d: Date): string {
  const copy = new Date(d);
  copy.setHours(12, 0, 0, 0);
  return copy.toISOString().slice(0, 10);
}

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
  isTemplate,
  onRemove,
  onServings,
}: {
  entry: QueueEntry;
  isTemplate?: boolean;
  onRemove: () => void;
  onServings: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: entry.id,
    disabled: entry.locked,
  });
  return (
    <div
      ref={setNodeRef}
      className={`tile ${entry.locked ? 'tile-locked' : ''} ${isDragging && !isTemplate ? 'tile-dragging' : ''}`}
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
        <div className="tile-sub">
          {entry.recipe.externalRating != null && (
            <span className="stars">★{entry.recipe.externalRating.toFixed(1)} </span>
          )}
        </div>
      </div>
      {!isTemplate && (
        <button
          className="tile-servings"
          title="Servings — tap to adjust (½×, 2×…)"
          disabled={entry.locked}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onServings();
          }}
        >
          ×{entry.servingsPlanned}
        </button>
      )}
      {entry.locked ? (
        <span className="tile-lock" title="Locked — a shopping list bought for this day">
          🔒
        </span>
      ) : (
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
  locked,
  empty,
  children,
}: {
  dayKey: string;
  date: Date;
  locked: boolean;
  empty: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${dayKey}`, disabled: locked });
  const today = localDayKey(new Date()) === dayKey;
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
      {empty && !locked && <div className="lane-empty">drop a meal here</div>}
      {children}
    </div>
  );
}

function UnassignedShelf({ empty, children }: { empty: boolean; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'unassigned' });
  return (
    <div ref={setNodeRef} className={`shelf ${isOver ? 'lane-over' : ''}`}>
      <div className="section-label">Templates — dragging COPIES onto a day</div>
      {empty && (
        <div className="lane-empty">stage recipes with ➕ Plan, or drag a scheduled tile here</div>
      )}
      <div className="shelf-row">{children}</div>
    </div>
  );
}

/** Bottom sheet for rescaling one entry's servings. */
function ServingsSheet({
  entry,
  onChange,
  onClose,
}: {
  entry: QueueEntry;
  onChange: (servings: number) => void;
  onClose: () => void;
}) {
  const base = entry.recipe.servings || entry.servingsPlanned || 2;
  const presets = [
    { label: '½×', value: Math.max(1, Math.round(base / 2)) },
    { label: '1×', value: base },
    { label: '2×', value: base * 2 },
  ];
  return (
    <div className="sheet">
      <div className="sheet-title">{entry.recipe.name}</div>
      <div className="sheet-row">
        <button
          className="chip"
          onClick={() => onChange(Math.max(1, entry.servingsPlanned - 1))}
        >
          −
        </button>
        <span className="sheet-value">×{entry.servingsPlanned} servings</span>
        <button className="chip" onClick={() => onChange(entry.servingsPlanned + 1)}>
          +
        </button>
        {presets.map((p) => (
          <button
            key={p.label}
            className={`chip ${entry.servingsPlanned === p.value ? 'active' : ''}`}
            onClick={() => onChange(p.value)}
          >
            {p.label}
          </button>
        ))}
        <button className="chip" onClick={onClose}>
          done
        </button>
      </div>
      <div className="muted sheet-hint">recipe makes {base} — shopping amounts scale with this</div>
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
  const [slot, setSlot] = useState('dinner');
  const [servingsFor, setServingsFor] = useState<string>();

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
  );

  const refresh = () => setNonce((n) => n + 1);
  const lockedKeys = useMemo(() => new Set(queue?.lockedDayKeys ?? []), [queue]);

  // Templates (unassigned) are slot-agnostic; the board shows only the active slot.
  const slotEntries = useMemo(
    () => (queue?.upcoming ?? []).filter((e) => e.slot === slot),
    [queue, slot],
  );
  const byDay = useMemo(() => {
    const m = new Map<string, QueueEntry[]>();
    for (const e of slotEntries) {
      const k = keyOf(e.date!);
      const list = m.get(k);
      if (list) list.push(e);
      else m.set(k, [e]);
    }
    return m;
  }, [slotEntries]);
  const days = boardDays();
  const firstKey = days[0]!.key;
  const lastKey = days[BOARD_DAYS - 1]!.key;
  const earlier = slotEntries.filter((e) => keyOf(e.date!) < firstKey);
  const later = slotEntries.filter((e) => keyOf(e.date!) > lastKey);
  const allEntries = useMemo(
    () => [...(queue?.unassigned ?? []), ...(queue?.upcoming ?? [])],
    [queue],
  );
  const servingsEntry = allEntries.find((e) => e.id === servingsFor);

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

    await run(async () => {
      if (over === 'unassigned') {
        // Scheduled tile dragged back to the shelf -> becomes a template.
        if (!entry.date) return;
        await api.patch(`/meal-plans/${entry.mealPlanId}/entries/${entry.id}`, { date: null });
      } else {
        const k = String(over).replace(/^day:/, '');
        const date = `${k}T12:00:00.000Z`;
        if (!entry.date) {
          // Template dropped on a day -> COPY: create a new entry, template stays.
          await api.post(`/meal-plans/${entry.mealPlanId}/entries`, {
            recipeId: entry.recipe.id,
            date,
            slot,
            servingsPlanned: entry.servingsPlanned,
          });
        } else {
          if (keyOf(entry.date) === k) return;
          await api.patch(`/meal-plans/${entry.mealPlanId}/entries/${entry.id}`, { date });
        }
      }
      refresh();
    });
  }

  async function remove(e: QueueEntry) {
    await run(async () => {
      await api.del(`/meal-plans/${e.mealPlanId}/entries/${e.id}`);
      refresh();
    });
  }

  async function setServings(e: QueueEntry, servings: number) {
    await run(async () => {
      await api.patch(`/meal-plans/${e.mealPlanId}/entries/${e.id}`, {
        servingsPlanned: servings,
      });
      refresh();
    });
  }

  async function fillDays() {
    setBusy(true);
    await run(async () => {
      const plan = await api.post<{ entries: unknown[] }>('/meal-plans/generate', { days: 7 });
      setMsg(`Queued dinners — ${plan.entries.length} scheduled over the next 7 days.`);
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
        `List "${list.name}": ${list.items.length} items for ${list.lockedMeals} meal(s) across all slots. Days locked.`,
      );
      refresh();
    });
    setBusy(false);
  }

  const renderTile = (e: QueueEntry, isTemplate = false) => (
    <MealTile
      key={e.id}
      entry={e}
      isTemplate={isTemplate}
      onRemove={() => remove(e)}
      onServings={() => setServingsFor(servingsFor === e.id ? undefined : e.id)}
    />
  );

  return (
    <section className="page">
      <div className="page-head">
        <h2>Meal queue</h2>
        <button className="btn-link" disabled={busy} onClick={fillDays}>
          ✨ Fill 7 days
        </button>
      </div>

      <div className="slot-tabs">
        {SLOTS.map((s) => (
          <button
            key={s.id}
            className={`slot-tab ${slot === s.id ? 'active' : ''}`}
            onClick={() => setSlot(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <button className="btn shop-cta" onClick={() => setShopOpen(!shopOpen)}>
        🛒 I'm going to the grocery store
      </button>
      {shopOpen && (
        <div className="card shop-panel">
          <div className="section-label">Shop how many days out? (covers every slot)</div>
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
        <UnassignedShelf empty={(queue?.unassigned ?? []).length === 0}>
          {(queue?.unassigned ?? []).map((e) => renderTile(e, true))}
        </UnassignedShelf>

        {earlier.length > 0 && (
          <>
            <div className="section-label">Earlier</div>
            {earlier.map((e) => renderTile(e))}
          </>
        )}

        <div className="board">
          {days.map(({ key, date }) => (
            <DayLane
              key={key}
              dayKey={key}
              date={date}
              locked={lockedKeys.has(key)}
              empty={(byDay.get(key) ?? []).length === 0}
            >
              {(byDay.get(key) ?? []).map((e) => renderTile(e))}
            </DayLane>
          ))}
        </div>

        {later.length > 0 && (
          <>
            <div className="section-label">Later</div>
            {later.map((e) => renderTile(e))}
          </>
        )}

        <DragOverlay>{dragging ? <TileGhost entry={dragging} /> : null}</DragOverlay>
      </DndContext>

      {servingsEntry && (
        <ServingsSheet
          entry={servingsEntry}
          onChange={(s) => setServings(servingsEntry, s)}
          onClose={() => setServingsFor(undefined)}
        />
      )}
    </section>
  );
}
