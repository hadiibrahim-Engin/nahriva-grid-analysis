import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { AnalysisContext } from '../hooks/useAnalysis';
import { readParam, writeParam } from '../util/shareLink';

/**
 * Holds the chosen analysis for the whole dashboard. Not remembered across visits on purpose: after a new
 * PowerFactory run the dashboard opens on the newest analysis, never on an older one chosen earlier.
 */
export default function AnalysisProvider({ children }: { children: ReactNode }) {
  // A shared link (?analysis=…) opens that analysis; otherwise the newest.
  const [analysis, setAnalysisState] = useState<string | null>(() => readParam('analysis'));
  const setAnalysis = useCallback((value: string | null) => {
    setAnalysisState(value);
    writeParam('analysis', value);
    writeParam('scenario', null); // a scenario belongs to one analysis
  }, []);
  const value = useMemo(() => ({ analysis, setAnalysis }), [analysis, setAnalysis]);
  return <AnalysisContext.Provider value={value}>{children}</AnalysisContext.Provider>;
}
