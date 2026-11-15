import { lazy, Suspense, useState } from 'react';
import DashboardSection from '../DashboardSection';
import ErrorBoundary from '../ErrorBoundary';
import GeneratingLoader from '../ui/GeneratingLoader';
import { SectionCard } from './shared';

const N1PairsChart = lazy(() => import('./N1PairsChart'));

/** Neither scrolling to this section nor Expand all starts contingency requests. */
export default function N1Review({ refreshKey }: { refreshKey: number }) {
  const [requested, setRequested] = useState(false);
  return (
    <DashboardSection workspace="n1">
      <div className="across-scope">
        <SectionCard title="n-1 results" collapsible={false} actions={
          <button type="button" className="ab-chip" aria-expanded={requested} aria-controls="n1-results" onClick={() => setRequested((value) => !value)}>
            {requested ? 'Hide n-1 results' : 'Load n-1 results'}
          </button>
        }>
          <div id="n1-results">
            {requested ? <ErrorBoundary label="n-1 review">
              <Suspense fallback={<GeneratingLoader minHeight={240} />}>
                <N1PairsChart key={refreshKey} kind="both" />
              </Suspense>
            </ErrorBoundary> : <p className="ab-sub">Load the contingency results to review overloaded branches and their causes.</p>}
          </div>
        </SectionCard>
      </div>
    </DashboardSection>
  );
}
