import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../api/client';
import { compare, type AnalysisComparison, type CompareCheck, type ElementDelta, type ScenarioComparison, type ScenarioPair } from '../api/compare';
import { utc } from '../api/views';
import { UNASSIGNED, type AnalysisInfo } from '../hooks/useAnalysis';
import { downloadText, toCsv } from '../util/csv';
import { useGridFilter } from '../hooks/useGridFilter';

const PAGE = 200;
const num = (v: number | null | undefined, digits = 1, unit = '') =>
  v === null || v === undefined || !Number.isFinite(v) ? '–' : `${v.toFixed(digits)}${unit}`;
const signed = (v: number | null | undefined, digits = 1, unit = '') =>
  v === null || v === undefined || !Number.isFinite(v) ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}${unit}`;
const when = (iso: string | null) => {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '–';
};
const describe = (a: AnalysisInfo) =>
  a.id === UNASSIGNED ? 'Earlier results' : `${a.name ? `${a.name} · ` : ''}${when(a.created_at)}${a.native_run_id ? ` · run ${a.native_run_id}` : ''}`;
const STATE_LABEL: Record<string, string> = { value: '', outaged: 'switched off', only_a: 'only in A', only_b: 'only in B' };
const CHECK_MARK: Record<CompareCheck['status'], string> = { ok: '✓', warning: '⚠', info: 'ℹ' };

/**
 * Analysis browser and comparison: search and filter the analyses of the file, pick two (A and B), see what makes
 * them comparable and their scenarios paired by switched-off equipment, and per pair every element in A and B with
 * the change, largest first.
 */
export default function CompareDialog({ refreshKey }: { refreshKey: number }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [analyses, setAnalyses] = useState<AnalysisInfo[] | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [picked, setPicked] = useState<string[]>([]);
  const [result, setResult] = useState<{ key: string; data: AnalysisComparison } | null>(null);
  const [error, setError] = useState('');
  const [pair, setPair] = useState<ScenarioPair | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    api.get<{ analyses: AnalysisInfo[] }>('/analyses', { signal: controller.signal })
      .then((response) => setAnalyses(response.data.analyses ?? []))
      .catch(() => { if (!controller.signal.aborted) setAnalyses([]); });
    return () => controller.abort();
  }, [open, refreshKey]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (analyses ?? []).filter((a) =>
      (status === 'all' || a.status === status)
      && (!needle || [a.name, a.project, a.study_case, a.native_run_id, a.engine_version, a.created_at, a.id]
        .some((v) => v?.toLowerCase().includes(needle))));
  }, [analyses, query, status]);
  const statuses = useMemo(() => [...new Set((analyses ?? []).map((a) => a.status))].sort(), [analyses]);

  const key = picked.length === 2 ? picked.join('|') : '';
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const [a, b] = key.split('|');
    compare.analyses(a, b, controller.signal)
      .then((data) => { setResult({ key, data }); setError(''); })
      .catch(() => { if (!controller.signal.aborted) setError('The two analyses could not be compared.'); });
    return () => controller.abort();
  }, [key]);
  const comparison = result?.key === key ? result.data : null;

  // Two at most: a third choice replaces the older one. The earlier analysis becomes A.
  const toggle = (id: string) => {
    setPair(null);
    setPicked((current) => {
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id].slice(-2);
      const order = new Map((analyses ?? []).map((a, i) => [a.id, i]));
      return next.sort((x, y) => (order.get(y) ?? 0) - (order.get(x) ?? 0));
    });
  };

  return (
    <>
      <button type="button" className="ab-chip" onClick={() => { setOpen(true); dialog.current?.showModal(); }}
        title="Browse the analyses of this file and compare two of them">
        Compare
      </button>
      <dialog ref={dialog} className="ab-dialog ab-dialog--wide" aria-label="Analyses and comparison" onClose={() => setOpen(false)}>
        <div className="ab-dialog__head">
          <h3 className="across-card__title">Analyses · compare A against B</h3>
          <button type="button" className="ab-chip" onClick={() => dialog.current?.close()}>Close</button>
        </div>
        <div className="ab-chips">
          <input type="search" className="ab-control" placeholder="Search project, study case, run …" aria-label="Search analyses"
            value={query} onChange={(e) => setQuery(e.target.value)} />
          <select className="ab-control" aria-label="Analysis status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">Every status</option>
            {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <span className="ab-sub">Tick two analyses: the earlier is A, the later B.</span>
        </div>
        {analyses === null && open && <div className="ab-empty" aria-busy>Loading analyses …</div>}
        {analyses !== null && (
          <div className="ab-compare__scroll ab-compare__list">
            <table className="ab-table">
              <thead><tr><th /><th>Created</th><th>Project / study case</th><th>Engine</th><th className="ab-num">Scenarios</th><th>Status</th><th>Period (UTC)</th></tr></thead>
              <tbody>
                {shown.map((a) => {
                  const side = picked.indexOf(a.id);
                  return (
                    <tr key={a.id} aria-selected={side >= 0} onClick={() => toggle(a.id)} className="ab-compare__row">
                      <td><input type="checkbox" checked={side >= 0} onChange={() => toggle(a.id)} onClick={(e) => e.stopPropagation()}
                        aria-label={`Compare ${describe(a)}`} /> {side >= 0 && <b>{side === 0 ? 'A' : 'B'}</b>}</td>
                      <td>{describe(a)}</td>
                      <td>{[a.project, a.study_case].filter(Boolean).join(' / ') || '–'}</td>
                      <td>{a.engine_version ?? '–'}</td>
                      <td className="ab-num">{a.scenarios}</td>
                      <td>{a.status}</td>
                      <td>{a.period_start !== null && a.period_end !== null ? `${utc(a.period_start)} – ${utc(a.period_end)}` : '–'}</td>
                    </tr>
                  );
                })}
                {shown.length === 0 && <tr><td colSpan={7} className="ab-sub">No analysis matches.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        {error && <p role="alert" className="ab-dialog__limits">{error}</p>}
        {picked.length === 2 && !comparison && !error && <div className="ab-empty" aria-busy>Comparing …</div>}
        {comparison && <AnalysisResult data={comparison} pair={pair} onPair={setPair} />}
      </dialog>
    </>
  );
}

function Checks({ checks }: { checks: CompareCheck[] }) {
  return (
    <ul className="ab-compare__checks" aria-label="Comparability">
      {checks.map((c) => (
        <li key={c.check} data-status={c.status}><span aria-hidden>{CHECK_MARK[c.status]}</span> <b>{c.check}</b> {c.detail}</li>
      ))}
    </ul>
  );
}

function AnalysisResult({ data, pair, onPair }: { data: AnalysisComparison; pair: ScenarioPair | null; onPair: (p: ScenarioPair | null) => void }) {
  return (
    <section className="ab-compare" aria-label="Comparison of the two analyses">
      <h4 className="across-card__title">Comparability</h4>
      <Checks checks={data.checks} />
      {data.settings.length > 0 && (
        <details>
          <summary className="ab-sub">{data.settings.length} setting(s) differ</summary>
          <table className="ab-table"><thead><tr><th>Setting</th><th>A</th><th>B</th></tr></thead>
            <tbody>{data.settings.map((s) => <tr key={s.setting}><td>{s.setting}</td><td>{JSON.stringify(s.a)}</td><td>{JSON.stringify(s.b)}</td></tr>)}</tbody>
          </table>
        </details>
      )}
      <h4 className="across-card__title">Scenarios (largest change of the peak loading first)</h4>
      <div className="ab-compare__scroll">
        <table className="ab-table">
          <thead>
            <tr>
              <th>Switched off</th><th>A</th><th>B</th>
              <th className="ab-num">Peak loading A</th><th className="ab-num">B</th><th className="ab-num">Δ</th>
              <th className="ab-num">Lowest voltage A</th><th className="ab-num">B</th>
              <th className="ab-num">Overloaded times A</th><th className="ab-num">B</th><th />
            </tr>
          </thead>
          <tbody>
            {data.pairs.map((p) => {
              const id = `${p.a?.id}|${p.b?.id}`;
              const chosen = pair !== null && `${pair.a?.id}|${pair.b?.id}` === id;
              return (
                <tr key={id} aria-selected={chosen}>
                  <td>{p.equipment.join(', ') || '–'}{p.a && p.b && !p.windows_equal && <span className="ab-sub">other outage window</span>}</td>
                  <td>{p.a ? p.a.name : <span className="ab-sub">not in A</span>}</td>
                  <td>{p.b ? p.b.name : <span className="ab-sub">not in B</span>}</td>
                  <td className="ab-num">{num(p.a?.loading_max, 1, ' %')}</td>
                  <td className="ab-num">{num(p.b?.loading_max, 1, ' %')}</td>
                  <td className="ab-num">{signed(p.delta_loading_max, 1, ' pp')}</td>
                  <td className="ab-num">{num(p.a?.voltage_min, 3)}</td>
                  <td className="ab-num">{num(p.b?.voltage_min, 3)}</td>
                  <td className="ab-num">{p.a?.overloaded_times ?? '–'}</td>
                  <td className="ab-num">{p.b?.overloaded_times ?? '–'}</td>
                  <td>{p.a && p.b && (
                    <button type="button" className="ab-chip" aria-pressed={chosen} onClick={() => onPair(chosen ? null : p)}>Elements</button>
                  )}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pair?.a && pair.b && <ElementComparison key={`${pair.a.id}|${pair.b.id}`} a={pair.a.id} b={pair.b.id} />}
    </section>
  );
}

const value = (v: ElementDelta['a'], metric: 'loading' | 'voltage') =>
  Array.isArray(v) ? `${num(v[0], 3)} … ${num(v[1], 3)}` : num(v, metric === 'loading' ? 1 : 3, metric === 'loading' ? ' %' : '');

function ElementComparison({ a, b }: { a: string; b: string }) {
  const [metric, setMetric] = useState<'loading' | 'voltage'>('loading');
  const { grid, kv } = useGridFilter();  // the header's global filters
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [result, setResult] = useState<{ key: string; data: ScenarioComparison } | null>(null);
  const [error, setError] = useState('');
  const key = `${metric}|${query}|${limit}|${grid}|${kv}`;

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      compare.scenarios(a, b, metric, { limit, offset: 0, q: query.trim() }, { grid, kv }, controller.signal)
        .then((data) => { setResult({ key, data }); setError(''); })
        .catch(() => { if (!controller.signal.aborted) setError('The two scenarios could not be compared.'); });
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [a, b, metric, query, limit, key, grid, kv]);
  const data = result?.key === key ? result.data : result?.data ?? null;
  const loading = metric === 'loading';
  const unit = loading ? ' pp' : ' p.u.';

  const exportCsv = () => {
    if (!data) return;
    const flat = (v: ElementDelta['a']) => (Array.isArray(v) ? v.map((x) => x ?? '').join(' … ') : v);
    downloadText(`compare-${metric}.csv`, toCsv(['Element', 'Type', 'Grid', 'kV', 'A', 'B', 'Change', 'State'],
      data.rows.map((r) => [r.name, r.type, r.grid, r.nominal_kv, flat(r.a), flat(r.b), r.delta, r.state])));
  };

  return (
    <section className="ab-compare" aria-label="Elements of the two scenarios">
      <div className="ab-dialog__head">
        <h4 className="across-card__title">Elements: {data ? `${data.a.name} (A) against ${data.b.name} (B)` : '…'}</h4>
        <div className="ab-chips">
          {(['loading', 'voltage'] as const).map((m) => (
            <button key={m} type="button" className="ab-chip" aria-pressed={metric === m} onClick={() => { setMetric(m); setLimit(PAGE); }}>
              {m === 'loading' ? 'Loading' : 'Voltage'}
            </button>
          ))}
          <input type="search" className="ab-control" placeholder="Element name …" aria-label="Search elements" value={query}
            onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }} />
          <button type="button" className="ab-chip" onClick={exportCsv} disabled={!data}>CSV</button>
        </div>
      </div>
      {error && <p role="alert" className="ab-dialog__limits">{error}</p>}
      {!data && !error && <div className="ab-empty" aria-busy>Comparing elements …</div>}
      {data && (
        <>
          <Checks checks={data.checks} />
          <p className="ab-sub">
            {data.counts.both} of {data.counts.total} elements in both · {data.counts.higher} higher and {data.counts.lower} lower in B
            (more than {data.tolerance}{unit}) · {loading ? 'highest loading in the outage window' : 'lowest … highest voltage in the outage window'}
          </p>
          <div className="ab-compare__scroll">
            <table className="ab-table">
              <thead><tr><th>Element</th><th>Grid</th><th className="ab-num">kV</th><th className="ab-num">A</th><th className="ab-num">B</th><th className="ab-num">B − A</th><th /></tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.element_id}>
                    <td>{r.name}<span className="ab-sub">{r.type}</span></td>
                    <td>{r.grid}</td>
                    <td className="ab-num">{r.nominal_kv ?? '–'}</td>
                    <td className="ab-num">{value(r.a, metric)}</td>
                    <td className="ab-num">{value(r.b, metric)}</td>
                    <td className="ab-num">{signed(r.delta, loading ? 1 : 3, unit)}</td>
                    <td className="ab-sub">{STATE_LABEL[r.state] ?? r.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.rows.length < data.filtered && (
            <button type="button" className="ab-chip" onClick={() => setLimit((l) => l + PAGE)}>
              Show more ({data.rows.length} of {data.filtered})
            </button>
          )}
        </>
      )}
    </section>
  );
}
