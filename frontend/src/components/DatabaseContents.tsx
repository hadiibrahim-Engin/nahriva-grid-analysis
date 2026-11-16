import { useMemo, useState } from 'react';
import type { AnalysisInfo } from '../hooks/useAnalysis';
import { UNASSIGNED } from '../hooks/useAnalysis';

export type ResultCounts = Record<string, number>;
export interface DatabaseInventory {
  path: string;
  filename: string;
  sqlite_bytes: number | null;
  default_analysis: string | null;
  totals: { calculations: number; cases: number; imported_cases: number; unassigned_cases: number;
    results: Record<string, ResultCounts> };
  analyses: (AnalysisInfo & { case_count: number; cases: { case_id: string; name: string; status: string; reason: string }[];
    results: Record<string, ResultCounts> })[];
}

const stored = (counts: ResultCounts = {}) => (counts.completed ?? 0) + (counts.incomplete ?? 0);
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '–';

function Results({ counts = {} }: { counts?: ResultCounts }) {
  return <><strong>{stored(counts)}</strong>
    {(counts.incomplete ?? 0) > 0 && <span className="ab-sub text-[var(--grid-warning)]">{counts.incomplete} incomplete</span>}
    {(counts.failed ?? 0) > 0 && <span className="ab-sub text-[var(--grid-danger)]">{counts.failed} failed</span>}
    {(counts.not_calculated ?? 0) > 0 && <span className="ab-sub">{counts.not_calculated} not calculated</span>}
    {Object.entries(counts).filter(([status]) => !['completed', 'incomplete', 'failed', 'not_calculated'].includes(status)).map(([status, count]) =>
      <span key={status} className="ab-sub">{count} {status.replaceAll('_', ' ')}</span>)}
  </>;
}

export default function DatabaseContents({ data, selected, onSelect }: {
  data: DatabaseInventory; selected: string | null; onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return data.analyses.filter((item) => !needle || [item.name, item.project, item.study_case, item.native_run_id, item.status,
      ...item.cases.map((c) => c.name)].some((value) => value?.toLocaleLowerCase().includes(needle)));
  }, [data, query]);
  const current = selected ?? data.default_analysis;
  const entries = [
    ['Calculations', data.totals.calculations], ['Cases', data.totals.cases],
    ['n-0 / QDS results', stored(data.totals.results.QDS)], ['n-1 results', stored(data.totals.results['n-1'])],
    ["(n-1)' results", stored(data.totals.results["(n-1)'"])],
  ] as const;
  return <div className="grid gap-4">
    <div>
      <h3 className="font-semibold">{data.filename}</h3>
      <p className="break-all text-xs text-[var(--grid-muted)]">{data.path}</p>
      {data.sqlite_bytes !== null && <p className="ab-sub mt-1">SQLite file: {(data.sqlite_bytes / 1024 ** 2).toLocaleString('en-GB', { maximumFractionDigits: 1 })} MB · external result files are separate</p>}
    </div>
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {entries.map(([label, value]) => <div key={label} className="ab-kpi"><dt className="ab-kpi__label">{label}</dt>
        <dd className="ab-kpi__value">{value.toLocaleString('en-GB')}</dd></div>)}
    </dl>
    <p className="text-sm text-[var(--grid-muted)]">{data.totals.imported_cases} cases have imported scenario records. Result counts include reference runs and incomplete imports. Failed or uncalculated results are listed separately below.
      {' '}Selecting a calculation loads its results; this overview reads names and import metadata.</p>
    {data.totals.unassigned_cases > 0 && <p role="note" className="text-sm">{data.totals.unassigned_cases} earlier cases have no calculation assignment and are listed as a separate group.</p>}
    <label className="block"><span className="grid-form-label">Find calculation or case</span>
      <input type="search" className="grid-form-input w-full" value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="Name, case, project, study case or status" /></label>
    <div className="ab-scroll max-h-[45vh] overflow-y-auto">
      <table className="ab-table" aria-label="Calculations in the open database"><thead><tr>
        <th>Calculation</th><th>Created</th><th>Cases</th><th>n-0 / QDS</th><th>n-1</th><th>(n-1)'</th><th>Import status</th><th />
      </tr></thead><tbody>
        {shown.map((item) => <tr key={item.id} aria-selected={current === item.id}>
          <td><strong>{item.id === UNASSIGNED ? 'Earlier results (unassigned)' : item.name ?? item.native_run_id}</strong>
            <span className="ab-sub">{[item.project, item.study_case].filter(Boolean).join(' / ')}</span></td>
          <td>{when(item.created_at)}</td>
          <td>{item.cases.length > 0 ? <details><summary>{item.case_count} cases</summary>
            <ul className="my-2 grid gap-1">{item.cases.map((c) => <li key={c.case_id}>
              {c.case_id} · {c.name}<span className="ab-sub">{c.status}{c.reason ? ` · ${c.reason}` : ''}</span>
            </li>)}</ul></details> : item.case_count}</td>
          <td><Results counts={item.results.QDS} /></td><td><Results counts={item.results['n-1']} /></td>
          <td><Results counts={item.results["(n-1)'"]} /></td><td>{item.status}</td>
          <td><button type="button" className="ab-chip" onClick={() => onSelect(item.id)}
            aria-label={`View calculation ${item.name ?? item.native_run_id ?? 'Earlier results'}`}>
            {current === item.id ? 'Viewing' : 'View calculation'}</button></td>
        </tr>)}
        {shown.length === 0 && <tr><td colSpan={8}>{data.analyses.length ? 'No calculation matches your search.' : 'This database contains no calculations yet.'}</td></tr>}
      </tbody></table>
    </div>
  </div>;
}
