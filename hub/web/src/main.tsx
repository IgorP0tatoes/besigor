import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { api, setUnauthorizedHandler } from './lib/api';
import { HubProvider } from './lib/hub';
import { Dashboard } from './pages/Dashboard';
import { Layout } from './pages/Layout';
import { Login } from './pages/Login';
import { ServerPage } from './pages/ServerPage';
import { Settings } from './pages/Settings';
import './styles.css';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function App() {
  const [auth, setAuth] = useState<'unknown' | 'in' | 'out'>('unknown');
  const logout = useCallback(() => setAuth('out'), []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    api('/api/me')
      .then(() => setAuth('in'))
      .catch(() => setAuth('out'));
  }, [logout]);

  if (auth === 'unknown') return null;
  if (auth === 'out') return <Login onLogin={() => setAuth('in')} />;
  return (
    <HubProvider>
      <Layout onLogout={logout}>
        <ErrorBoundary fallback={<main className="page muted">Что-то пошло не так. Обновите страницу.</main>}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/servers/:id" element={<ServerPage />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Dashboard />} />
          </Routes>
        </ErrorBoundary>
      </Layout>
    </HubProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ScrollToTop />
      <App />
    </BrowserRouter>
  </StrictMode>,
);
