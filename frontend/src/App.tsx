import { lazy, Suspense } from 'react';
import ErrorBoundary from './components/ErrorBoundary';
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
export default function App() {
  return <Suspense fallback={<div className="min-h-screen bg-[var(--grid-bg)] text-[var(--grid-muted)] p-8">Lädt…</div>}><ErrorBoundary label="Outage Assessment"><DashboardPage /></ErrorBoundary></Suspense>;
}
