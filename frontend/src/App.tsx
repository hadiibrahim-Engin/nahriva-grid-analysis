import { lazy, Suspense } from 'react';
import ErrorBoundary from './components/ErrorBoundary';
import AnalysisProvider from './components/AnalysisProvider';
import GridFilterProvider from './components/GridFilterProvider';
// Each workspace loads its own page; the standalone map does not download the dashboard's chart gallery.
const DashboardPage = lazy(()=>import('./pages/DashboardPage'));
const NetworkPage = lazy(()=>import('./pages/NetworkPage'));
export default function App() {
  return <Suspense fallback={<div className="min-h-screen bg-[var(--grid-bg)] text-[var(--grid-muted)] p-8">Loading…</div>}><ErrorBoundary label="Outage Assessment"><AnalysisProvider><GridFilterProvider>{window.location.pathname==='/network' ? <NetworkPage/> : <DashboardPage />}</GridFilterProvider></AnalysisProvider></ErrorBoundary></Suspense>;
}
