import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { costcoBookmarkletHref } from '../lib/costcoBookmarklet.js';

interface SettingsData {
  name: string;
  currency: string;
  timeValuePerMinute: number;
}

interface ProviderRow {
  id: string;
  name: string;
}
interface ParsedRow {
  name: string;
  price: number;
  size?: string;
}

/** Paste any messy text → local LLM parses Name / size / price → confirm → save to a store. */
function PasteParse() {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<ParsedRow[]>();
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [providerId, setProviderId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();

  useEffect(() => {
    api
      .get<ProviderRow[]>('/providers')
      .then((p) => {
        setProviders(p);
        setProviderId(p[0]?.id ?? '');
      })
      .catch(() => {});
  }, []);

  async function parse() {
    setBusy(true);
    setMsg(undefined);
    setRows(undefined);
    try {
      const res = await api.post<{ items: ParsedRow[] }>('/integrations/parse-prices', { text });
      setRows(res.items);
      if (!res.items.length) setMsg('No priced items found in that text.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function edit(i: number, patch: Partial<ParsedRow>) {
    setRows((rs) => rs?.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function drop(i: number) {
    setRows((rs) => rs?.filter((_, j) => j !== i));
  }

  async function saveAll() {
    if (!rows?.length || !providerId) return;
    setBusy(true);
    try {
      const res = await api.post<{ recorded: number; linked: number }>(
        `/providers/${providerId}/bulk-prices`,
        { items: rows.filter((r) => r.name && r.price > 0) },
      );
      const store = providers.find((p) => p.id === providerId)?.name ?? 'store';
      setMsg(`Saved ${res.recorded} price(s) to ${store} (${res.linked} auto-linked).`);
      setRows(undefined);
      setText('');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card add-card">
      <div className="card-title">📋 Paste prices (AI parse)</div>
      <p className="muted sheet-hint">
        Paste a receipt, product list, or notes — the local AI pulls out name, size &amp; price.
      </p>
      <textarea
        className="paste-box"
        rows={4}
        placeholder={'e.g.\nOrganic eggs 24ct  7.99\nKS olive oil 2L $18.99\nchicken thighs 4lb 9.47'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button className="btn btn-inline" disabled={busy || !text.trim()} onClick={parse}>
        {busy && !rows ? 'Parsing…' : '✨ Parse'}
      </button>

      {rows && rows.length > 0 && (
        <div className="parsed">
          <div className="capture-row" style={{ margin: '10px 0' }}>
            <span className="muted">Save to:</span>
            <select className="chip" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {rows.map((r, i) => (
            <div key={i} className="parsed-row">
              <input value={r.name} onChange={(e) => edit(i, { name: e.target.value })} />
              <input
                className="size-input"
                placeholder="size"
                value={r.size ?? ''}
                onChange={(e) => edit(i, { size: e.target.value })}
              />
              <input
                className="price-input"
                type="number"
                inputMode="decimal"
                value={r.price}
                onChange={(e) => edit(i, { price: Number(e.target.value) })}
              />
              <button className="entry-x" onClick={() => drop(i)}>
                ✕
              </button>
            </div>
          ))}
          <button className="btn btn-inline" disabled={busy} onClick={saveAll}>
            {busy ? 'Saving…' : `Save ${rows.length} to store`}
          </button>
        </div>
      )}
      {msg && <p className="notice">{msg}</p>}
    </div>
  );
}

/** Install the bookmarklet + paste Costco prices scraped by it. */
function CostcoImport() {
  const linkRef = useRef<HTMLAnchorElement>(null);
  const [paste, setPaste] = useState('');
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);

  // React strips javascript: hrefs, so set it on the DOM node directly.
  useEffect(() => {
    if (linkRef.current) linkRef.current.setAttribute('href', costcoBookmarkletHref);
  }, []);

  async function submit() {
    setBusy(true);
    setMsg(undefined);
    try {
      const body = JSON.parse(paste);
      const res = await api.post<{ recorded: number; linked: number; skipped: number }>(
        '/integrations/costco/receipts',
        body,
      );
      setMsg(`Imported ${res.recorded} Costco price(s), ${res.linked} auto-linked to your items.`);
      setPaste('');
    } catch (e) {
      setMsg(
        e instanceof SyntaxError
          ? 'That doesn’t look like the copied data — click the bookmarklet on a Costco page first.'
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card add-card">
      <div className="card-title">🏬 Import Costco prices</div>
      <p className="muted sheet-hint">
        Costco has no API and blocks automated logins, so grab prices from your own browser:
      </p>
      <ol className="costco-steps">
        <li>
          Drag this to your bookmarks bar (desktop):{' '}
          {/* eslint-disable-next-line jsx-a11y/anchor-is-valid */}
          <a ref={linkRef} className="bookmarklet" onClick={(e) => e.preventDefault()}>
            🛒 Costco → Pantrezy
          </a>
        </li>
        <li>On costco.com — a product page, search results, or Orders &amp; Purchases — click it.</li>
        <li>It copies the items; paste below and Import.</li>
      </ol>
      <textarea
        className="paste-box"
        placeholder="Paste the copied Costco data here…"
        value={paste}
        onChange={(e) => setPaste(e.target.value)}
        rows={3}
      />
      <button className="btn btn-inline" disabled={busy || !paste.trim()} onClick={submit}>
        {busy ? 'Importing…' : 'Import'}
      </button>
      {msg && <p className="notice">{msg}</p>}
    </div>
  );
}

export function Settings() {
  const [data, setData] = useState<SettingsData>();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.get<SettingsData>('/settings').then(setData).catch((e) => setError(String(e.message ?? e)));
  }, []);

  async function save() {
    if (!data) return;
    setSaved(false);
    try {
      await api.patch('/settings', {
        name: data.name,
        currency: data.currency,
        timeValuePerMinute: data.timeValuePerMinute,
      });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (error) return <section className="page"><h2>Settings</h2><p className="error">{error}</p></section>;
  if (!data) return <section className="page"><h2>Settings</h2><p className="muted">Loading…</p></section>;

  return (
    <section className="page">
      <h2>Settings</h2>
      <label className="field">
        <span>Household name</span>
        <input value={data.name} onChange={(e) => setData({ ...data, name: e.target.value })} />
      </label>
      <label className="field">
        <span>Currency</span>
        <input value={data.currency} onChange={(e) => setData({ ...data, currency: e.target.value })} />
      </label>
      <label className="field">
        <span>Value of a shopping minute (λ)</span>
        <input
          type="number"
          step="0.05"
          value={data.timeValuePerMinute}
          onChange={(e) => setData({ ...data, timeValuePerMinute: Number(e.target.value) })}
        />
        <small className="muted">Higher λ → fewer store stops. Used by the optimizer.</small>
      </label>
      <button className="btn" onClick={save}>
        Save
      </button>
      {saved && <p className="notice">Saved.</p>}

      <PasteParse />
      <CostcoImport />
    </section>
  );
}
