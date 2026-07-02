import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { costcoBookmarkletHref } from '../lib/costcoBookmarklet.js';

interface SettingsData {
  name: string;
  currency: string;
  timeValuePerMinute: number;
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
            🛒 Costco → Meals
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

      <CostcoImport />
    </section>
  );
}
