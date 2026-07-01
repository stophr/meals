import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

interface SettingsData {
  name: string;
  currency: string;
  timeValuePerMinute: number;
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
    </section>
  );
}
