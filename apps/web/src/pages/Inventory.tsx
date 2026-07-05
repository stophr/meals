import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { UNIT_TABLE, BASE_UNIT, dimensionOf } from '@meals/shared';
import type { UnitDimension, Unit } from '@meals/shared';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { BarcodeScanner } from '../components/BarcodeScanner.js';

// Units grouped by what they measure, Imperial-first for a US household. A count can't be
// deducted against a recipe's "2 cups sugar", so weight/volume lead each group.
const UNIT_GROUPS: { label: string; units: Unit[] }[] = [
  { label: 'Weight', units: ['LB', 'OZ', 'G', 'KG', 'MG'] },
  { label: 'Volume', units: ['CUP', 'TBSP', 'TSP', 'FLOZ', 'ML', 'L'] },
  { label: 'Count', units: ['EACH', 'PACK', 'CAN', 'BOTTLE', 'BUNCH'] },
];
// Friendly default when stocking an item of a given measurement type.
const DEFAULT_UNIT: Record<UnitDimension, string> = { MASS: 'LB', VOLUME: 'CUP', COUNT: 'EACH' };

function defaultUnitFor(baseUnit?: string | null): string {
  return baseUnit ? DEFAULT_UNIT[dimensionOf(baseUnit as Unit)] : 'EACH';
}

function UnitSelect({
  value,
  onChange,
  className = 'chip',
}: {
  value: string;
  onChange: (u: string) => void;
  className?: string;
}) {
  return (
    <select className={className} value={value} onChange={(e) => onChange(e.target.value)}>
      {UNIT_GROUPS.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.units.map((u) => (
            <option key={u} value={u}>
              {u.toLowerCase()}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

interface Lot {
  id: string;
  quantity: string;
  unit: string;
  brand?: string | null;
  location?: string | null;
  expiresAt?: string | null;
  canonicalItem: {
    id: string;
    name: string;
    category?: string | null;
    baseUnit?: string | null;
    assumeStocked?: boolean;
  };
  product?: { imageUrl?: string | null; description?: string | null; brand?: string | null } | null;
}
interface ItemHit {
  id: string;
  name: string;
  category?: string | null;
  baseUnit?: string | null;
}

const CATEGORY_ORDER = [
  'Produce',
  'Meat & Seafood',
  'Dairy & Eggs',
  'Bakery & Baking',
  'Grains & Pasta',
  'Canned & Jarred',
  'Spices & Seasoning',
  'Condiments & Sauces',
  'Frozen',
  'Beverages',
  'Snacks',
  'Other',
];

function fmtQty(q: string): string {
  const n = Number(q);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}

function expiryBadge(expiresAt?: string | null) {
  if (!expiresAt) return null;
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  const cls = days < 0 ? 'badge-expired' : days <= 3 ? 'badge-part' : 'badge-ok';
  const label = days < 0 ? 'expired' : days === 0 ? 'today' : `${days}d`;
  return <span className={`badge ${cls}`}>{label}</span>;
}

export interface LotPatch {
  quantity: number;
  unit: string;
  brand?: string | null;
  location?: string;
  expiresAt?: string;
}
export interface ItemPatch {
  assumeStocked?: boolean;
  baseUnit?: string;
  baseDimension?: string;
}

/** Bottom sheet to edit every attribute of one pantry lot: amount, unit, location, expiry. */
function LotSheet({
  lot,
  onSave,
  onClose,
}: {
  lot: Lot;
  onSave: (patch: LotPatch, item: ItemPatch) => void;
  onClose: () => void;
}) {
  const [qty, setQty] = useState(Number(lot.quantity));
  const [unit, setUnit] = useState(lot.unit);
  const [brand, setBrand] = useState(lot.brand ?? '');
  const [location, setLocation] = useState(lot.location ?? '');
  const [expires, setExpires] = useState(lot.expiresAt ? lot.expiresAt.slice(0, 10) : '');
  const [stocked, setStocked] = useState(lot.canonicalItem.assumeStocked ?? false);
  const step = ['G', 'ML'].includes(unit) ? 50 : ['KG', 'L', 'LB'].includes(unit) ? 0.5 : 1;
  const dim = UNIT_TABLE[unit as keyof typeof UNIT_TABLE]?.dimension;
  const dimLabel = dim === 'MASS' ? 'by weight' : dim === 'VOLUME' ? 'by volume' : 'by count';

  function save() {
    if (qty <= 0) return;
    const item: ItemPatch = {};
    if (stocked !== (lot.canonicalItem.assumeStocked ?? false)) item.assumeStocked = stocked;
    // Persist the item's default measurement type so future adds don't default to "count".
    const desiredBase = BASE_UNIT[dim];
    if (desiredBase !== lot.canonicalItem.baseUnit) {
      item.baseUnit = desiredBase;
      item.baseDimension = dim;
    }
    onSave(
      {
        quantity: qty,
        unit,
        brand: brand.trim() || null,
        location: location.trim() || undefined,
        expiresAt: expires || undefined,
      },
      item,
    );
  }

  return (
    <div className="sheet">
      <div className="sheet-title">{lot.canonicalItem.name}</div>
      <div className="sheet-row">
        <button className="chip" onClick={() => setQty(Math.max(0, +(qty - step).toFixed(2)))}>
          −
        </button>
        <input
          className="sheet-input"
          type="number"
          min={0}
          step="any"
          value={qty}
          onChange={(e) => setQty(Number(e.target.value))}
        />
        <button className="chip" onClick={() => setQty(+(qty + step).toFixed(2))}>
          +
        </button>
        <UnitSelect value={unit} onChange={setUnit} />
        <span className="muted">{dimLabel}</span>
      </div>
      <div className="sheet-row">
        <input
          className="sheet-input sheet-input-wide"
          placeholder="brand (optional — e.g. Jif, Kirkland)"
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
        />
      </div>
      <div className="sheet-row">
        <input
          className="sheet-input sheet-input-wide"
          placeholder="location (Pantry, Fridge, Freezer…)"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
      </div>
      <div className="sheet-row">
        <label className="muted">expires</label>
        <input
          className="sheet-input"
          type="date"
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
        />
      </div>
      <label className="sheet-row sheet-check">
        <input type="checkbox" checked={stocked} onChange={(e) => setStocked(e.target.checked)} />
        <span>Always in stock (like water) — never add to shopping lists</span>
      </label>
      <div className="sheet-row">
        <button className="chip active" onClick={save} disabled={qty <= 0}>
          save
        </button>
        <button className="chip" onClick={onClose}>
          cancel
        </button>
      </div>
      <div className="muted sheet-hint">amounts drive cook-from-pantry and shopping lists</div>
    </div>
  );
}

interface Draft {
  name: string;
  brand: string | null;
  quantity: number;
  unit: string;
}

/** Read a File to base64 (no data: prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/** Add pantry items from a spoken/typed description, a photo, a video, or an audio file. */
function MultimodalAdd({ onAdded }: { onAdded: (n: number) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [drafts, setDrafts] = useState<Draft[]>();

  async function extract(body: Record<string, unknown>) {
    setBusy(true);
    setMsg(undefined);
    setDrafts(undefined);
    try {
      const r = await api.post<{ items?: Draft[]; message?: string }>('/inventory/extract', body);
      if (r.message) setMsg(r.message);
      else if (!r.items?.length) setMsg('Nothing recognized — try again or add manually.');
      else setDrafts(r.items);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const source = file.type.startsWith('image')
      ? 'image'
      : file.type.startsWith('video')
        ? 'video'
        : file.type.startsWith('audio')
          ? 'audio'
          : 'image';
    const dataBase64 = await fileToBase64(file);
    await extract({ source, dataBase64, mediaType: file.type });
  }

  async function confirm() {
    if (!drafts?.length) return;
    setBusy(true);
    try {
      const r = await api.post<{ added: number }>('/inventory/bulk-add', { items: drafts });
      setDrafts(undefined);
      setText('');
      setMsg(`Added ${r.added} item(s) to your pantry.`);
      onAdded(r.added);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card add-card">
      <button className="btn-link" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} 🎙️ Add from description, photo, video, or audio
      </button>
      {open && (
        <div className="mm-add">
          <textarea
            className="mm-text"
            placeholder="Describe what you have — e.g. “2 lb chicken, a dozen eggs, half a bag of rice, 3 cans black beans”"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
          />
          <div className="sheet-row">
            <button
              className="btn btn-inline"
              disabled={busy || !text.trim()}
              onClick={() => extract({ source: 'text', text })}
            >
              Read text
            </button>
            <label className="chip mm-file">
              📷 Photo/Video/Audio
              <input
                type="file"
                accept="image/*,video/*,audio/*"
                capture="environment"
                hidden
                onChange={onFile}
              />
            </label>
          </div>
          {busy && <p className="muted">Reading… (local model, a few seconds)</p>}
          {msg && <p className="notice">{msg}</p>}

          {drafts && (
            <div className="mm-review">
              <div className="section-label">Review, then add — ingredient · brand · amount</div>
              {drafts.map((d, i) => (
                <div key={i} className="mm-row">
                  <input
                    className="sheet-input mm-name"
                    placeholder="ingredient"
                    value={d.name}
                    onChange={(e) =>
                      setDrafts(drafts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                    }
                  />
                  <input
                    className="sheet-input mm-brand"
                    placeholder="brand (optional)"
                    value={d.brand ?? ''}
                    onChange={(e) =>
                      setDrafts(
                        drafts.map((x, j) => (j === i ? { ...x, brand: e.target.value || null } : x)),
                      )
                    }
                  />
                  <input
                    className="sheet-input mm-qty"
                    type="number"
                    min={0}
                    step="any"
                    value={d.quantity}
                    onChange={(e) =>
                      setDrafts(
                        drafts.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)),
                      )
                    }
                  />
                  <UnitSelect
                    value={d.unit}
                    onChange={(u) => setDrafts(drafts.map((x, j) => (j === i ? { ...x, unit: u } : x)))}
                  />
                  <button className="entry-x" onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                </div>
              ))}
              <button className="btn btn-inline" disabled={busy || !drafts.length} onClick={confirm}>
                Add {drafts.length} to pantry
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Inventory() {
  const [nonce, setNonce] = useState(0);
  const { data, error, loading } = useApi<Lot[]>(() => api.get('/inventory'), [nonce]);
  const [search, setSearch] = useState('');
  const [msg, setMsg] = useState<string>();
  const [removed, setRemoved] = useState<string[]>([]);
  const [editing, setEditing] = useState<Lot>();

  // Add flow
  const [addQuery, setAddQuery] = useState('');
  const [addResults, setAddResults] = useState<ItemHit[]>();
  const [addSel, setAddSel] = useState<ItemHit>();
  const [addQty, setAddQty] = useState(1);
  const [addUnit, setAddUnit] = useState('EACH');
  const [addBrand, setAddBrand] = useState('');
  const [addProductId, setAddProductId] = useState<string>();
  const [addImageUrl, setAddImageUrl] = useState<string>();
  const [addExpires, setAddExpires] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  // True while the current add originated from a scan — so tapping Add reopens the scanner for
  // the next item (rapid stock-as-you-unpack), while manual adds don't pop the camera.
  const [fromScan, setFromScan] = useState(false);

  const refresh = () => setNonce((n) => n + 1);
  useEffect(() => setRemoved([]), [data]);

  // Autocomplete against the item catalog.
  useEffect(() => {
    if (!addQuery.trim() || addSel) {
      setAddResults(undefined);
      return;
    }
    const t = setTimeout(async () => {
      const hits = await api.get<ItemHit[]>(`/items?q=${encodeURIComponent(addQuery.trim())}`);
      setAddResults(hits.slice(0, 8));
    }, 250);
    return () => clearTimeout(t);
  }, [addQuery, addSel]);

  const lots = useMemo(() => {
    const visible = (data ?? []).filter((l) => !removed.includes(l.id));
    const q = search.trim().toLowerCase();
    return q ? visible.filter((l) => l.canonicalItem.name.toLowerCase().includes(q)) : visible;
  }, [data, removed, search]);

  const groups = useMemo(() => {
    const m = new Map<string, Lot[]>();
    for (const lot of lots) {
      const cat = lot.canonicalItem.category || 'Other';
      const list = m.get(cat);
      if (list) list.push(lot);
      else m.set(cat, [lot]);
    }
    for (const list of m.values())
      list.sort((a, b) => a.canonicalItem.name.localeCompare(b.canonicalItem.name));
    return [...m.entries()].sort(
      (a, b) =>
        (CATEGORY_ORDER.indexOf(a[0]) + 100 || 999) - (CATEGORY_ORDER.indexOf(b[0]) + 100 || 999) ||
        a[0].localeCompare(b[0]),
    );
  }, [lots]);

  function pickItem(hit: ItemHit) {
    setAddSel(hit);
    setAddQuery(hit.name);
    setAddUnit(defaultUnitFor(hit.baseUnit));
    setAddBrand('');
    setAddProductId(undefined);
    setAddImageUrl(undefined);
    setAddResults(undefined);
  }

  async function createItem() {
    const name = addQuery.trim();
    if (!name) return;
    const item = await api.post<ItemHit>('/items', { name });
    pickItem(item);
  }

  async function onScanned(code: string) {
    setScanning(false);
    setScanBusy(true);
    setMsg(undefined);
    const upc = code.replace(/\D/g, '');
    try {
      const r = await api.get<{
        found: boolean;
        productId?: string;
        item?: ItemHit;
        brand?: string | null;
        imageUrl?: string | null;
        size?: { quantity: number; unit: string } | null;
        nutrition?: { calories?: number } | null;
        descriptionSource?: string;
        nutritionSource?: string | null;
        message?: string;
      }>(`/items/barcode/${upc}`);
      if (r.found && r.item) {
        pickItem(r.item); // sets item, default unit, clears brand/product/image
        setFromScan(true);
        setAddProductId(r.productId);
        setAddImageUrl(r.imageUrl ?? undefined);
        if (r.brand) setAddBrand(r.brand);
        if (r.size) {
          setAddQty(r.size.quantity);
          setAddUnit(r.size.unit);
        }
        const bits = [
          r.brand,
          r.size ? `${r.size.quantity} ${r.size.unit.toLowerCase()}` : null,
          r.nutrition?.calories != null ? `${Math.round(r.nutrition.calories)} cal/serving` : null,
        ].filter(Boolean);
        setMsg(`Scanned: ${[r.item.name, ...bits].join(' · ')} — check the amount and tap Add.`);
      } else {
        setAddSel(undefined);
        setAddQuery('');
        setFromScan(false);
        setAddProductId(undefined);
        setAddImageUrl(undefined);
        setMsg(
          r.message ??
            `${upc} isn’t in our sources. If it’s loose produce, type the 4–5 digit PLU from the sticker (e.g. 4011); otherwise type the item name.`,
        );
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setScanBusy(false);
    }
  }

  async function addLot() {
    if (!addSel || addQty <= 0) return;
    const name = addSel.name;
    const chain = fromScan; // remember before we reset
    setMsg(undefined);
    try {
      await api.post('/inventory', {
        canonicalItemId: addSel.id,
        productId: addProductId,
        quantity: addQty,
        unit: addUnit,
        brand: addBrand.trim() || undefined,
        expiresAt: addExpires || undefined,
      });
      setAddSel(undefined);
      setAddQuery('');
      setAddQty(1);
      setAddBrand('');
      setAddProductId(undefined);
      setAddImageUrl(undefined);
      setAddExpires('');
      setFromScan(false);
      refresh();
      // Scanned item added -> jump straight back to the camera for the next one.
      if (chain) {
        setMsg(`Added ${name}. Scan the next item.`);
        setScanning(true);
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(lot: Lot) {
    setMsg(undefined);
    setRemoved((r) => [...r, lot.id]);
    try {
      await api.del(`/inventory/${lot.id}`);
      refresh();
    } catch (e) {
      setRemoved((r) => r.filter((id) => id !== lot.id));
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveLot(lot: Lot, patch: LotPatch, item: ItemPatch) {
    setMsg(undefined);
    setEditing(undefined);
    try {
      await api.patch(`/inventory/${lot.id}`, patch);
      if (Object.keys(item).length) await api.patch(`/items/${lot.canonicalItem.id}`, item);
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="page">
      <h2>Pantry</h2>

      <div className="card add-card">
        <div className="section-label">Add to pantry</div>
        <div className="search-row">
          <input
            placeholder="Find or create an item…"
            value={addQuery}
            onChange={(e) => {
              setAddQuery(e.target.value);
              setAddSel(undefined);
              setFromScan(false);
              setAddBrand('');
              setAddProductId(undefined);
              setAddImageUrl(undefined);
            }}
          />
          <button
            className="btn btn-inline scan-btn"
            onClick={() => setScanning(true)}
            disabled={scanBusy}
            title="Scan a product barcode"
          >
            {scanBusy ? '…' : '📷 Scan'}
          </button>
        </div>
        {addResults && (
          <div className="autocomplete">
            {addResults.map((h) => (
              <button key={h.id} className="autocomplete-row" onClick={() => pickItem(h)}>
                {h.name}
                {h.category && <span className="muted"> · {h.category}</span>}
              </button>
            ))}
            {!addResults.some((h) => h.name.toLowerCase() === addQuery.trim().toLowerCase()) && (
              <button className="autocomplete-row autocomplete-new" onClick={createItem}>
                ＋ create “{addQuery.trim()}”
              </button>
            )}
          </div>
        )}
        {addSel && (
          <>
            {addImageUrl && (
              <div className="sheet-row">
                <img className="scan-thumb" src={addImageUrl} alt="" />
                <span className="muted">{addSel.name}</span>
              </div>
            )}
            <div className="sheet-row add-amount-row">
              <input
                className="sheet-input"
                type="number"
                min={0}
                step="any"
                value={addQty}
                onChange={(e) => setAddQty(Number(e.target.value))}
              />
              <UnitSelect value={addUnit} onChange={setAddUnit} />
              <button className="btn btn-inline" onClick={addLot} disabled={addQty <= 0}>
                Add
              </button>
            </div>
            <div className="sheet-row">
              <input
                className="sheet-input sheet-input-wide"
                placeholder="brand (optional — e.g. Heinz)"
                value={addBrand}
                onChange={(e) => setAddBrand(e.target.value)}
              />
            </div>
            <div className="sheet-row">
              <label className="muted">expires</label>
              <input
                className="sheet-input"
                type="date"
                value={addExpires}
                onChange={(e) => setAddExpires(e.target.value)}
              />
            </div>
          </>
        )}
      </div>

      <MultimodalAdd onAdded={() => refresh()} />

      <div className="search-row">
        <input placeholder="Search pantry…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {msg && <p className="notice">{msg}</p>}
      {loading && !data && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {data && lots.length === 0 && <p className="muted">Nothing here — add items above.</p>}

      {groups.map(([category, catLots]) => (
        <div key={category}>
          <div className="section-label">{category}</div>
          <ul className="plan-entries queue-list pantry-list">
            {catLots.map((lot) => (
              <li key={lot.id}>
                {lot.product?.imageUrl && <img className="pantry-thumb" src={lot.product.imageUrl} alt="" />}
                <span className="plan-recipe">{lot.canonicalItem.name}</span>
                {lot.brand && <span className="muted"> · {lot.brand}</span>}
                {lot.location && <span className="muted"> · {lot.location}</span>}
                {lot.canonicalItem.assumeStocked && <span className="badge badge-ok">always</span>}
                {expiryBadge(lot.expiresAt)}
                <button
                  className="tile-servings"
                  title="Tap to change amount"
                  onClick={() => setEditing(lot)}
                >
                  {fmtQty(lot.quantity)} {lot.unit.toLowerCase()}
                </button>
                <button className="entry-x" title="Used up — remove" onClick={() => remove(lot)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {editing && (
        <LotSheet
          lot={editing}
          onSave={(patch, item) => saveLot(editing, patch, item)}
          onClose={() => setEditing(undefined)}
        />
      )}

      {scanning && <BarcodeScanner onDetected={onScanned} onClose={() => setScanning(false)} />}
    </section>
  );
}
