import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import { SectionCard } from './across/shared';
import { progressView, type PfProgress } from '../util/progress';
import { isSynthetic, provenancePeriod, resultContexts, type ResultProvenance, type ResultScenario } from '../util/resultProvenance';
interface Job { id: string; status: string; name?: string | null; message?: string }
interface Overview { catalog: ResultProvenance | null; scenarios: ResultScenario[]; database_path: string; jobs?: Job[]; progress?: PfProgress | null; }
export default function OutageManagement({ onResultsChanged }: { onResultsChanged: () => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const callback = useRef(onResultsChanged);
  // null until the first answer: that one is the starting point, not a change worth refreshing everything for.
  const scenarioIds = useRef<string | null>(null);
  useEffect(() => { callback.current = onResultsChanged; }, [onResultsChanged]);
  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const { data } = await api.get<Overview>('/outage-management');
        if (!active) return;
        setOverview(data); setError('');
        const ids = data.scenarios.map(s => s.id).join(',');
        const changed = scenarioIds.current !== null && ids !== scenarioIds.current;
        scenarioIds.current = ids;
        if (changed) callback.current();
      } catch { if (active) setError('The results database could not be loaded.'); }
    }
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const catalog = overview?.catalog;
  const contexts = resultContexts(overview?.scenarios ?? [], catalog ?? null);
  const first = contexts[0]?.provenance;
  const summary = contexts.length
    ? [`${overview?.scenarios.length ?? 0} scenarios`, first?.project, first?.study_case].filter(Boolean).join(' · ')
    : 'No results yet';
  const running = overview?.jobs?.find((job) => job.status === 'running' || job.status === 'queued');
  // The script's own note says more than a job (it also covers the reference run and the LODF, where no job
  // exists yet); the job is the fallback for a database written by a script without progress notes.
  const note = progressView(overview?.progress);
  return <>
    {note ? (
      <div className="ab-progress" role={note.tone === 'running' ? 'status' : 'alert'} aria-live="polite" data-tone={note.tone}>
        {note.tone === 'running' && <span className="ab-live" aria-hidden />}
        {note.fraction !== null && <span className="ab-progress__bar" aria-hidden><span style={{ width: `${note.fraction * 100}%` }} /></span>}
        {note.text}
      </div>
    ) : running && (
      <div className="ab-progress" role="status" aria-live="polite">
        <span className="ab-live" aria-hidden />
        PowerFactory is calculating{running.name ? `: ${running.name}` : ''}
      </div>
    )}
  <SectionCard title="Outage Management" defaultOpen={false} summary={summary}>
    <p className="text-xs text-[var(--grid-muted)]">{contexts.length ? `${overview?.scenarios.length ?? 0} saved outage scenarios · ${overview?.scenarios.length ? 'Origin of the saved results' : 'Synchronised calculation context · no results yet'}` : 'No results yet. The PowerFactory script starts the calculation and this dashboard.'}</p>
    {contexts.map(({ provenance: p, count, lastResult }, index) => {
      const synthetic = isSynthetic(p);
      const fields = [
        { label: 'Model / project', value: p.project || 'Not recorded', path: p.project_path },
        { label: 'Study / study case', value: p.study_case || 'Not recorded', path: p.study_case_path },
        { label: 'PowerFactory-Version', value: synthetic ? 'Not used · synthetic data' : p.powerfactory_version || 'Not recorded' },
        { label: 'Data source', value: synthetic ? 'Dummy QDS · synthetic test data' : p.data_source || 'Not recorded' },
        { label: 'Simulation period', value: provenancePeriod(p.period) },
        ...(p.sample_interval_seconds ? [{ label: 'Time resolution', value: `${p.sample_interval_seconds / 60} minutes` }] : []),
        ...(p.qds_command ? [{ label: 'QDS calculation', value: p.qds_command.name, path: p.qds_command.path }] : []),
        ...(p.operational_scenario ? [{ label: 'Operating scenario', value: p.operational_scenario.name, path: p.operational_scenario.path }] : []),
        ...(p.networks?.length ? [{ label: 'Active grids', value: p.networks.map(grid => grid.name).join(', '), path: p.networks.map(grid => grid.path).join('\n') }] : []),
        ...(p.grid_name_filter ? [{ label: 'Grid filter', value: p.grid_name_filter }] : []),
      ];
      return <div key={index} className="mt-3 border-t border-[var(--grid-border)] pt-3">
        {contexts.length > 1 && <p className="mb-2 text-xs font-semibold">Calculation context {index + 1} · {count} scenarios</p>}
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
          {fields.map(field => <div key={field.label} className="min-w-0">
            <dt className="text-[11px] text-[var(--grid-muted)]">{field.label}</dt>
            <dd className="mt-0.5 break-words text-xs font-medium" title={field.path}>{field.value}</dd>
          </div>)}
        </dl>
        {lastResult && <p className="mt-3 text-[11px] text-[var(--grid-muted)]">Last saved result: {new Date(lastResult).toLocaleString('en-GB')}</p>}
        {synthetic && <p className="mt-2 text-xs text-[var(--grid-muted)]">Synthetic test model · no PowerFactory calculation.</p>}
      </div>;
    })}
    {overview?.database_path && <p className="mt-3 break-all text-[11px] text-[var(--grid-muted)]" title="Active results database">Database: {overview.database_path}</p>}
    {error && <p role="alert" className="mt-2 text-sm text-red-400">{error}</p>}
  </SectionCard>
  </>;
}
