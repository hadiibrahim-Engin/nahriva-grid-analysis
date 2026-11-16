import { useEffect, useState } from 'react';
import api from '../api/client';
import SearchableDropdown from './SearchableDropdown';
import { UNASSIGNED, useAnalysis, type AnalysisInfo } from '../hooks/useAnalysis';

const when = (iso: string | null) => {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
};

const analysisLabel = (a: AnalysisInfo) => {
  if (a.id === UNASSIGNED) return `Earlier results (${a.scenarios} scenarios)`;
  const status = a.status === 'complete' ? '' : ` · ${a.status}`;
  // The run id is the stamp of the kept result objects in PowerFactory (OA_<run id>): unique per run.
  const run = a.native_run_id ? ` · run ${a.native_run_id}` : '';
  return `${a.name ? `${a.name} · ` : ''}${when(a.created_at)}${run} · ${[a.project, a.study_case].filter(Boolean).join(' / ')} · ${a.scenarios} cases${status}`;
};

/** Analysis dropdown of the dashboard header; empty selection = the newest analysis. */
export default function AnalysisPicker({ refreshKey }: { refreshKey: number }) {
  const { analysis, setAnalysis } = useAnalysis();
  const [analyses, setAnalyses] = useState<AnalysisInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.get<{ analyses: AnalysisInfo[] }>('/analyses')
      .then((response) => { if (active) setAnalyses(Array.isArray(response.data?.analyses) ? response.data.analyses : []); })
      .catch(() => { if (active) setAnalyses([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refreshKey]);

  // A chosen analysis that is no longer in the file (another database was opened) falls back to the newest.
  useEffect(() => {
    if (!loading && analysis !== null && !analyses.some((a) => a.id === analysis)) setAnalysis(null);
  }, [loading, analysis, analyses, setAnalysis]);

  return (
    <SearchableDropdown
      label="Analysis"
      items={analyses}
      idOf={(a) => a.id}
      labelOf={analysisLabel}
      value={analysis}
      onChange={setAnalysis}
      placeholder="- Newest analysis -"
      emptyHint="No analysis in this database"
      loading={loading}
      loadingLabel="Loading analyses"
      className="min-w-[260px]"
    />
  );
}
