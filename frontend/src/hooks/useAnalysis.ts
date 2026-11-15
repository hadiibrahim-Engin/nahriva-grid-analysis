import { createContext, useContext } from 'react';

/** One analysis: one import of one PowerFactory run (GET /api/simulation/analyses). */
export interface AnalysisInfo {
  id: string;
  native_run_id: string | null;
  project: string | null;
  study_case: string | null;
  engine_version: string | null;
  created_at: string | null;
  mode: string | null;
  /** importing, complete, failed or unknown (imported before the status was recorded). */
  status: string;
  source_system: string;
  calculation_types: string[];
  period_start: number | null;
  period_end: number | null;
  scenarios: number;
}

/** Scenarios saved without an analysis form this group (backend across.UNASSIGNED). */
export const UNASSIGNED = 'unassigned';

export interface AnalysisSelection {
  /** The chosen analysis; null = the newest, as the server decides. */
  analysis: string | null;
  setAnalysis: (analysis: string | null) => void;
}

/**
 * The analysis chosen in the dashboard header (see components/AnalysisProvider). The summary, the scenario list of
 * the filters and the n-1 charts show this analysis only, never a mix of several imports. Without a provider: the newest.
 */
export const AnalysisContext = createContext<AnalysisSelection>({ analysis: null, setAnalysis: () => {} });

export const useAnalysis = (): AnalysisSelection => useContext(AnalysisContext);

/** Query parameters that pass the selection on; none for the newest. */
export const analysisParams = (analysis: string | null): Record<string, string> => (analysis === null ? {} : { analysis });
