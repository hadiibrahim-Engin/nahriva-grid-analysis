import { Suspense } from 'react';
import ErrorBoundary from './components/ErrorBoundary';
import AnalysisProvider from './components/AnalysisProvider';
import GridFilterProvider from './components/GridFilterProvider';
// The only page, so it is part of the first download: loaded lazily it was requested only after the entry had run.
import DashboardPage from './pages/DashboardPage';
export default function App() {
  return <Suspense fallback={<div className="min-h-screen bg-[var(--grid-bg)] text-[var(--grid-muted)] p-8">Loading…</div>}><ErrorBoundary label="Outage Assessment"><AnalysisProvider><GridFilterProvider><DashboardPage /></GridFilterProvider></AnalysisProvider></ErrorBoundary></Suspense>;
}
