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

const ROLE_LABEL: Record<string, string> = { base: 'Base', sous_chef: 'Sous chef', chef: 'Chef' };

interface OrgUser {
  id: string;
  email: string;
  role: string;
  isAppAdmin: boolean;
}

/** Add / role / remove members of one org. householdId targets an org (app-admin); omit for own. */
function UserManager({ householdId }: { householdId?: string }) {
  const [users, setUsers] = useState<OrgUser[]>();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('base');
  const [err, setErr] = useState<string>();
  const q = householdId ? `?householdId=${householdId}` : '';
  const load = () => api.get<OrgUser[]>(`/users${q}`).then(setUsers).catch(() => setUsers([]));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [householdId]);

  async function add() {
    setErr(undefined);
    try {
      await api.post('/users', { email: email.trim(), role, ...(householdId ? { householdId } : {}) });
      setEmail('');
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  async function setRoleFor(id: string, r: string) {
    await api.patch(`/users/${id}/role`, { role: r });
    load();
  }
  async function remove(id: string) {
    await api.del(`/users/${id}`);
    load();
  }

  return (
    <div className="user-mgr">
      <ul className="sub-list">
        {users?.length === 0 && <li className="muted">No members yet.</li>}
        {users?.map((u) => (
          <li key={u.id}>
            <span>
              {u.email}
              {u.isAppAdmin && ' 👑'}
            </span>
            <select
              className="chip"
              value={u.role}
              disabled={u.isAppAdmin}
              onChange={(e) => setRoleFor(u.id, e.target.value)}
            >
              <option value="base">base</option>
              <option value="sous_chef">sous chef</option>
              <option value="chef">chef</option>
            </select>
            {!u.isAppAdmin && (
              <button className="entry-x" title="Remove" onClick={() => remove(u.id)}>
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="sheet-row">
        <input
          className="sheet-input sheet-input-wide"
          placeholder="new member email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <select className="chip" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="base">base</option>
          <option value="sous_chef">sous chef</option>
          <option value="chef">chef</option>
        </select>
        <button className="btn btn-inline" disabled={!email.trim()} onClick={add}>
          Add
        </button>
      </div>
      {err && <p className="notice">{err}</p>}
    </div>
  );
}

interface AdminOrg {
  id: string;
  name: string;
  users: OrgUser[];
}

/** App-admin view: every org, its members, and creating new orgs. */
function AdminOrgs() {
  const [orgs, setOrgs] = useState<AdminOrg[]>();
  const [name, setName] = useState('');
  const [chefEmail, setChefEmail] = useState('');
  const load = () => api.get<AdminOrg[]>('/orgs').then(setOrgs).catch(() => setOrgs([]));
  useEffect(() => {
    load();
  }, []);
  async function createOrg() {
    await api.post('/orgs', { name: name.trim(), ...(chefEmail.trim() ? { chefEmail: chefEmail.trim() } : {}) });
    setName('');
    setChefEmail('');
    load();
  }
  return (
    <div>
      <div className="section-label">All organizations</div>
      {orgs?.map((o) => (
        <details key={o.id} className="org-block">
          <summary>
            {o.name} <span className="muted">· {o.users.length} member(s)</span>
          </summary>
          <UserManager householdId={o.id} />
        </details>
      ))}
      <div className="section-label">Create an org</div>
      <div className="sheet-row">
        <input
          className="sheet-input"
          placeholder="org name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="sheet-input"
          placeholder="chef email (optional)"
          value={chefEmail}
          onChange={(e) => setChefEmail(e.target.value)}
        />
        <button className="btn btn-inline" disabled={!name.trim()} onClick={createOrg}>
          Create
        </button>
      </div>
    </div>
  );
}

function OrgPanel() {
  const [me, setMe] = useState<{
    provisioned: boolean;
    email?: string;
    role?: string;
    isAppAdmin?: boolean;
    org?: { name?: string } | null;
  }>();
  useEffect(() => {
    api.get<typeof me>('/auth/me').then(setMe).catch(() => {});
  }, []);
  if (!me) return null;

  return (
    <div className="card add-card">
      <div className="card-title">🏛️ Organization</div>
      {!me.provisioned ? (
        <p className="muted">
          Signed in as <strong>{me.email}</strong>, but you're not a member of any org yet — ask
          an app admin to add you.
        </p>
      ) : (
        <>
          <p>
            {me.org?.name ?? 'Your org'} ·{' '}
            <span className="role-badge">{ROLE_LABEL[me.role ?? ''] ?? me.role}</span>
            {me.isAppAdmin && ' · app admin'}
          </p>
          {me.isAppAdmin ? (
            <AdminOrgs />
          ) : me.role === 'chef' ? (
            <>
              <div className="section-label">Members of your org</div>
              <UserManager />
            </>
          ) : (
            <p className="muted sheet-hint">Your chef manages members.</p>
          )}
        </>
      )}
    </div>
  );
}

function SubstitutionsPanel() {
  const [subs, setSubs] = useState<
    { id: string; from: { name: string }; to: { name: string }; recipe: { name: string } | null }[]
  >();
  const load = () => api.get<typeof subs>('/substitutions').then(setSubs).catch(() => setSubs([]));
  useEffect(() => {
    load();
  }, []);
  async function revert(id: string) {
    await api.del(`/substitutions/${id}`);
    load();
  }
  return (
    <div className="card add-card">
      <div className="card-title">🔄 Ingredient substitutions</div>
      {subs && subs.length === 0 && (
        <p className="muted">
          None yet. On any recipe, tap 🔄 next to an ingredient to always swap it (e.g. Olive
          Oil → Avocado Oil). It's remembered org-wide until you revert it here.
        </p>
      )}
      <ul className="sub-list">
        {subs?.map((s) => (
          <li key={s.id}>
            <span>
              {s.from.name} → <strong>{s.to.name}</strong>{' '}
              <span className="muted">{s.recipe ? `(only ${s.recipe.name})` : '(everywhere)'}</span>
            </span>
            <button className="entry-x" title="Revert" onClick={() => revert(s.id)}>
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface KrogerStatus {
  configured: boolean;
  cartAuthorized: boolean;
  linkedProviders: { id: string; name: string; locationId: string | null }[];
}
interface KLocation {
  locationId: string;
  chain: string;
  name: string;
  address: string;
  lat?: number;
  lng?: number;
}

/** Connect your Fry's store (by zip) and link your Fry's account for cart pushes. */
function KrogerPanel() {
  const [status, setStatus] = useState<KrogerStatus>();
  const [zip, setZip] = useState('');
  const [results, setResults] = useState<KLocation[]>();
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = () =>
    api.get<KrogerStatus>('/integrations/kroger/status').then(setStatus).catch(() => {});
  useEffect(() => {
    load();
    // Coming back from the Fry's OAuth redirect (/?kroger=linked) — refresh + toast.
    if (new URLSearchParams(window.location.search).get('kroger') === 'linked') {
      setMsg('Fry’s account linked ✓');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  async function search() {
    if (!/^\d{5}$/.test(zip.trim())) {
      setMsg('Enter a 5-digit zip code.');
      return;
    }
    setBusy(true);
    setMsg(undefined);
    setResults(undefined);
    try {
      const r = await api.get<KLocation[]>(`/integrations/kroger/locations?zip=${zip.trim()}&chain=FRYS`);
      setResults(r);
      if (!r.length) setMsg('No Fry’s found near that zip.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function connect(loc: KLocation) {
    setBusy(true);
    try {
      await api.post('/integrations/kroger/connect', {
        locationId: loc.locationId,
        name: loc.name,
        address: loc.address,
        lat: loc.lat,
        lng: loc.lng,
      });
      setMsg(`Connected ${loc.name}. Prices populate when you build a shopping list.`);
      setResults(undefined);
      setZip('');
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  return (
    <div className="card add-card">
      <div className="section-label">🏪 Fry's / Kroger</div>
      {!status.configured ? (
        <p className="muted">Kroger isn’t configured on the server (KROGER_CLIENT_ID / KROGER_CLIENT_SECRET).</p>
      ) : (
        <>
          {status.linkedProviders.length > 0 ? (
            <div className="card-sub">
              Connected: <strong>{status.linkedProviders.map((p) => p.name).join(', ')}</strong>
            </div>
          ) : (
            <div className="card-sub muted">No store connected — find your closest Fry’s below.</div>
          )}

          <div className="sheet-row">
            <input
              className="sheet-input"
              inputMode="numeric"
              placeholder="your zip code"
              value={zip}
              onChange={(e) => setZip(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && search()}
            />
            <button className="btn btn-inline" onClick={search} disabled={busy}>
              Find my Fry’s
            </button>
          </div>

          {results?.map((loc) => (
            <div key={loc.locationId} className="sheet-row">
              <span>
                {loc.name} <span className="muted">· {loc.address}</span>
              </span>
              <button className="chip" onClick={() => connect(loc)} disabled={busy}>
                Connect
              </button>
            </div>
          ))}

          <div className="sheet-row" style={{ marginTop: 8, alignItems: 'center' }}>
            {status.cartAuthorized ? (
              <span className="badge badge-ok">✓ Fry’s account linked</span>
            ) : (
              <button
                className="btn btn-inline"
                onClick={() => {
                  window.location.href = '/api/integrations/kroger/authorize';
                }}
              >
                Link my Fry’s account
              </button>
            )}
            <small className="muted">Lets the app push your shopping list into your real Fry’s cart.</small>
          </div>
        </>
      )}
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
      <OrgPanel />
      <KrogerPanel />
      <SubstitutionsPanel />
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
