import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { HealthResponse } from '@meals/shared';
import { api } from './lib/api.js';
import { useApi } from './lib/useApi.js';
import { Recipes } from './pages/Recipes.js';
import { Plan } from './pages/Plan.js';
import { Inventory } from './pages/Inventory.js';
import { Shopping } from './pages/Shopping.js';
import { Settings } from './pages/Settings.js';

function Header() {
  const { data } = useApi<HealthResponse>(() => api.health(), []);
  const online = data?.db === 'up';
  return (
    <header className="app-header">
      <h1>Pantrezy</h1>
      <span className={`status-dot ${online ? 'ok' : 'down'}`} title={`API: ${data?.status ?? '…'}`} />
    </header>
  );
}

const tabs = [
  { to: '/recipes', label: 'Recipes', icon: '🍳' },
  { to: '/plan', label: 'Plan', icon: '🗓️' },
  { to: '/inventory', label: 'Pantry', icon: '🧺' },
  { to: '/shopping', label: 'Shop', icon: '🛒' },
  { to: '/settings', label: 'Settings', icon: '⚙️' },
];

/** Gate: an authenticated-but-not-provisioned user (Cloudflare let them in, no org membership)
 * sees a message instead of a broken app. Members (any role) pass through. */
function MemberGate({ children }: { children: ReactNode }) {
  const { data, loading } = useApi<{ provisioned: boolean; email?: string }>(
    () => api.get('/auth/me'),
    [],
  );
  if (loading) return <p className="muted" style={{ padding: 24 }}>Loading…</p>;
  if (data && data.provisioned === false) {
    return (
      <div className="app">
        <Header />
        <main className="app-main">
          <section className="page">
            <h2>Not a member yet</h2>
            <p>
              You're signed in as <strong>{data.email}</strong>, but you haven't been added to an
              organization. Ask an app admin or a chef to add you, then reload.
            </p>
          </section>
        </main>
      </div>
    );
  }
  return <>{children}</>;
}

export function App() {
  return (
    <MemberGate>
    <div className="app">
      <Header />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Navigate to="/recipes" replace />} />
          <Route path="/recipes" element={<Recipes />} />
          <Route path="/plan" element={<Plan />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/shopping" element={<Shopping />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
      <nav className="tab-bar">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => (isActive ? 'tab active' : 'tab')}>
            <span className="tab-icon">{t.icon}</span>
            <span className="tab-label">{t.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
    </MemberGate>
  );
}
