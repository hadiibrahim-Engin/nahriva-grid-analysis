import { useEffect, useState } from 'react';
import { gridlens, type NativeAssessment as Assessment, type NativeCase, type NativeResult, type SourceEvaluation } from '../api/gridlens';
import { useAnalysis, UNASSIGNED } from '../hooks/useAnalysis';
import { SectionCard } from './across/shared';

type Detail = Assessment & { cases: NativeCase[]; results: NativeResult[]; evaluations: Record<string, SourceEvaluation> };

function SweepExtremes({ result }: { result: NativeResult }) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<Awaited<ReturnType<typeof gridlens.extremes>> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    gridlens.extremes(result.id, page * 50, controller.signal).then(setData).catch(() => {
      if (!controller.signal.aborted) setError('Could not load contingency extremes.');
    });
    return () => controller.abort();
  }, [result.id, page]);
  return <details className="ab-sub" open><summary>{result.kind} · {result.status}{result.reason ? ` · ${result.reason}` : ''}</summary>
    {Number(result.metadata.unresolved_rows) > 0 && <p role="alert">
      {Number(result.metadata.unresolved_rows)} rows could not be assigned to a contingency. The result is incomplete.
      {' '}<a href={`/api/simulation/gridlens/results/${encodeURIComponent(result.id)}/unresolved-rows`} target="_blank" rel="noreferrer">Inspect retained rows and diagnostics</a>
    </p>}
    {error ? <p role="alert">{error}</p> : !data ? <p role="status">Loading extremes …</p> : <>
      <p>{data.total} quantities with explicit extremes · ranked by limit exceedance. {data.total === 0 && 'No explicit extremes available. Check the recording limits and import status; sparse code-3 cells have no stored numeric value.'}</p>
      <div className="overflow-x-auto"><table className="ab-table"><thead><tr>
        <th>Equipment</th><th>Quantity</th><th>Minimum</th><th>Maximum</th><th>Lower / upper limit</th><th>Study times outside limits</th>
      </tr></thead><tbody>{data.rows.map((row, index) => <tr key={index}>
        <td>{row.name}</td><td>{row.variable} ({row.unit})</td><td>{row.low ?? '–'}</td><td>{row.high ?? '–'}</td>
        <td>{row.lower ?? '–'} / {row.upper ?? '–'}</td><td>{row.violation_times}</td>
      </tr>)}</tbody></table></div>
      <div className="ab-chips"><button type="button" className="ab-chip" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
        <span>Page {page + 1} / {Math.max(1, Math.ceil(data.total / 50))}</span>
        <button type="button" className="ab-chip" disabled={(page + 1) * 50 >= data.total} onClick={() => setPage(page + 1)}>Next</button></div>
    </>}
  </details>;
}

/** Original source judgments cover the saved run and its network scope, independent of browser limits. */
export default function NativeAssessment({ refreshKey }: { refreshKey: number }) {
  const { analysis } = useAnalysis();
  const [state, setState] = useState<{ scope: string | null; detail: Detail | null; error: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const id = analysis ?? (await gridlens.sweeps(null, controller.signal)).analysis;
        const detail = id && id !== UNASSIGNED ? await gridlens.assessment(id, controller.signal) : null;
        if (controller.signal.aborted) return;
        setState({ scope: analysis, detail, error: '' });
        if (detail && (['importing', 'evaluating'].includes(detail.status) || Object.values(detail.evaluations).some((e) => e.status === 'pending'))) {
          timer = setTimeout(load, 3000);
        }
      } catch {
        if (!controller.signal.aborted) setState({ scope: analysis, detail: null, error: 'Could not load the source assessment.' });
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [analysis, refreshKey]);
  if (!state || state.scope !== analysis) return <p role="status">Loading source assessment …</p>;
  if (state.error) return <p role="alert">{state.error}</p>;
  const detail = state.detail;
  if (!detail) return null;
  const sweeps = detail.results.filter((r) => r.kind !== 'QDS');
  const requested = Array.isArray(detail.configuration.assessments) && detail.configuration.assessments.some((a) => a === 'n-1');
  return <SectionCard title={`${detail.name} · PowerFactory assessment ${detail.engine_version}`} summary="Original outage assessment findings">
    <a className="ab-chip" href={`/api/simulation/gridlens/assessments/${encodeURIComponent(detail.id)}`} download={`assessment-${detail.id}.json`}>Download full source findings</a>
    <p className="ab-sub">Stored contingency results: {sweeps.filter((r) => r.kind === 'n-1').length} n-1 · {sweeps.filter((r) => r.kind === "(n-1)'").length} (n-1)'</p>
    {sweeps.length === 0 && <p role="status">{detail.status === 'importing' ? 'n-1 results have not been imported yet.'
      : requested ? 'n-1 was requested, but no native n-1 results were stored. Reimport the kept run from PowerFactory Results.'
        : 'No n-1 results were imported for this calculation. Select a calculation with n-1 results or calculate and import n-1 in PowerFactory.'}</p>}
    <p className="ab-sub">Original assessment of the saved run and network scope. Dashboard limits and filters below apply to the dashboard analysis.</p>
    {[...(detail.evaluations.REF ? [{ case_id: 'REF', name: 'Reference' }] : []), ...detail.cases].map((item) => {
      const evaluation = detail.evaluations[item.case_id];
      return <article key={item.case_id} className="grid gap-2 my-3">
        <h4>{item.case_id} · {item.name}</h4>
        {!evaluation ? <p>Original assessment unavailable for this import.</p> : <>
          <p>{evaluation.status === 'pending' ? 'Original assessment is being evaluated …' : evaluation.status}
            {evaluation.reason ? ` · ${evaluation.reason}` : ''}</p>
          <p>n-0: <strong>{item.case_id === 'REF' ? 'Baseline' : evaluation.n0?.assessment ?? 'Not evaluated'}</strong></p>
          {evaluation.n1 && (evaluation.n1.status || evaluation.n1.summary) && <p>{evaluation.n1.kind ?? 'n-1'}: <strong>{evaluation.n1.summary ?? evaluation.n1.status}</strong>
            {evaluation.n1.reason ? ` · ${evaluation.n1.reason}` : ''}</p>}
          {!!evaluation.episodes?.length && <details><summary>{evaluation.episodes.length} of {evaluation.episodes_total ?? evaluation.episodes.length} n-0 violation episodes</summary>
            <div className="overflow-x-auto"><table className="ab-table"><thead><tr>
              <th>Equipment</th><th>Location</th><th>Finding</th><th>Start</th><th>End</th><th>Peak</th><th>Status</th>
            </tr></thead><tbody>{evaluation.episodes.map((episode, index) => <tr key={index}>
              <td>{episode.element_name}</td><td>{episode.location_text}</td><td>{episode.criterion}</td>
              <td>{episode.start_text}</td><td>{episode.end_text}</td><td>{episode.peak_text}</td><td>{episode.status}</td>
            </tr>)}</tbody></table></div></details>}
        </>}
        {detail.results.filter((r) => r.case_id === item.case_id && r.kind !== 'QDS').map((result) => <SweepExtremes key={result.id} result={result} />)}
      </article>;
    })}
  </SectionCard>;
}
