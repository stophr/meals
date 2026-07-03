import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
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

export function App() {
  return (
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
  );
}
