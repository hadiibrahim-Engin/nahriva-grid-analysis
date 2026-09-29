import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import {
  Activity,
  BarChart3,
  Database,
  LogOut,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import type { Capabilities } from "./api/types";
import { sessionKey } from "./api/client";
import { useResource } from "./hooks/useResource";
import { ErrorBoundary, ErrorState, Loading } from "./components/States";
import Login from "./components/Login";
const AnalysisPage = lazy(() => import("./pages/AnalysisPage"));
const FdwhPage = lazy(() => import("./pages/FdwhPage"));
const SourcesPage = lazy(() => import("./pages/SourcesPage"));

export default function App() {
  const capabilities = useResource<Capabilities>("/analysis/capabilities");
  const [authenticated, setAuthenticated] = useState(
    Boolean(sessionStorage.getItem(sessionKey)),
  );
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const logout = () => setAuthenticated(false);
    window.addEventListener("analysis:logout", logout);
    return () => window.removeEventListener("analysis:logout", logout);
  }, []);
  function logout() {
    sessionStorage.removeItem(sessionKey);
    setAuthenticated(false);
  }
  const config = capabilities.data;
  return (
    <BrowserRouter>
      <a href="#main" className="skip-link">
        Zum Inhalt
      </a>
      <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
        <aside className="sidebar">
          <a className="brand" href="/">
            <span className="brand-mark">
              <Activity size={23} />
            </span>
            <span>
              NAHRIVA<small>GRID ANALYSIS</small>
            </span>
          </a>
          <div className="sidebar-label">ARBEITSBEREICH</div>
          <nav aria-label="Hauptnavigation">
            <NavLink to="/" end>
              <BarChart3 size={19} />
              <span>Analyseübersicht</span>
            </NavLink>
            <NavLink to="/fdwh">
              <Activity size={19} />
              <span>FDWH-Messdaten</span>
            </NavLink>
            <NavLink to="/sources">
              <Database size={19} />
              <span>Datenquellen</span>
            </NavLink>
          </nav>
          <div className="sidebar-bottom">
            <div className="integration-status">
              <Network size={18} />
              <span>
                PowerFactory<small>Integration vorbereitet</small>
              </span>
            </div>
            <button
              onClick={() => setCollapsed((v) => !v)}
              aria-label={
                collapsed ? "Navigation ausklappen" : "Navigation einklappen"
              }
            >
              {collapsed ? (
                <PanelLeftOpen size={18} />
              ) : (
                <PanelLeftClose size={18} />
              )}
              <span>Navigation einklappen</span>
            </button>
          </div>
        </aside>
        <div className="workspace">
          <div className="topbar">
            <span>
              <span className="topbar-product">Power System Insights</span>
              <span className="topbar-separator">/</span>Data Analysis
            </span>
            <div>
              {config?.mode === "demo" && (
                <span className="demo-badge">
                  <span />
                  Beispieldaten
                </span>
              )}
              {authenticated && (
                <button onClick={logout}>
                  <LogOut size={14} />
                  Abmelden
                </button>
              )}
              <span className="version">v1.0</span>
            </div>
          </div>
          <main id="main">
            <ErrorBoundary>
              {capabilities.loading ? (
                <Loading />
              ) : capabilities.error ? (
                <ErrorState
                  message={capabilities.error}
                  retry={capabilities.reload}
                />
              ) : (
                config &&
                (config.auth_required && !authenticated ? (
                  <Login onSuccess={() => setAuthenticated(true)} />
                ) : (
                  <Suspense fallback={<Loading />}>
                    <Routes>
                      <Route
                        path="/"
                        element={<AnalysisPage key={String(authenticated)} />}
                      />
                      <Route
                        path="/fdwh"
                        element={
                          <FdwhPage
                            authenticated={authenticated}
                            capabilities={config}
                            onLogin={() => setAuthenticated(true)}
                          />
                        }
                      />
                      <Route
                        path="/sources"
                        element={<SourcesPage capabilities={config} />}
                      />
                      <Route
                        path="*"
                        element={
                          <section className="state">
                            <h1>Ansicht nicht gefunden</h1>
                            <a href="/">Zur Analyseübersicht</a>
                          </section>
                        }
                      />
                    </Routes>
                  </Suspense>
                ))
              )}
            </ErrorBoundary>
          </main>
          <footer>
            Nahriva Grid Analysis
            <span>Simulationen · Messdaten · Technische Auswertung</span>
          </footer>
        </div>
      </div>
    </BrowserRouter>
  );
}
