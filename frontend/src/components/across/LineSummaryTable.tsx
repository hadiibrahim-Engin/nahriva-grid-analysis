import { useCallback, useMemo, useState } from 'react';
import { ANALYSIS, LOADING_LIMITS, bandOf, bandVar, type BandId } from '../../config/loadingBands';
import {
  PATTERN_LABELS,
  fmtExcess,
  fmtLodf,
  fmtNum,
  fmtPct,
  fmtPp,
  fmtHours,
  fmtShare,
  severityIndex,
  type LineStats,
  type ScenarioStats,
  SUMMARY_IDS,
} from '../../util/acrossScenarios';
import { causeCounts, equipmentTitle } from '../../util/outageAssessment';
import EquipmentName from './EquipmentName';
import { DataBar, DivergingBar, ScenarioTag, SectionCard } from './shared';

type SortKey =
  | 'name' | 'base' | 'min' | 'max' | 'delta' | 'spread' | 'n100' | 'n110' | 'n120'
  | 'rate' | 'sumExcess' | 'maxExcess' | 'meanExcess' | 'lodf' | 'lodfScenario' | 'status' | 'maxScenario';

interface Column { key: SortKey; label: string; title: string; align?: 'right'; detail?: boolean }

const COLUMNS: Column[] = [
  { key: 'name', label: 'Equipment', title: 'Line (no mark) or transformer (T)' },
  { key: 'status', label: 'Status', title: 'Severity of the highest loading and detected pattern' },
  { key: 'base', label: 'Base', title: 'Base loading: REF maximum over the whole period', align: 'right' },
  { key: 'min', label: 'Min', title: 'Smallest scenario loading (equipment in service)', align: 'right' },
  { key: 'max', label: 'Max Loading', title: 'Largest scenario loading' },
  { key: 'maxScenario', label: 'Scenario', title: 'Scenario at max loading' },
  { key: 'delta', label: 'Max Δ Loading', title: 'Largest change against REF in the same outage window, in pp (sorted by magnitude)' },
  { key: 'spread', label: 'Max Δ between scenarios', title: 'Largest minus smallest scenario loading, in pp' },
  { key: 'n100', label: 'Scen. > 100 %', title: 'Number of scenarios with loading > 100 %', align: 'right' },
  { key: 'n110', label: 'Scen. > 110 %', title: 'Number of scenarios with loading > 110 %', align: 'right' },
  { key: 'n120', label: 'Scen. > 120 %', title: 'Number of scenarios with loading > 120 %', align: 'right' },
  { key: 'rate', label: 'Overload Rate', title: 'Time above 100 % in the worst scenario, relative to the simulation period' },
  { key: 'sumExcess', label: 'Sum Excess', title: 'Sum of max(loading − 100 %, 0) over all scenarios, in pp' },
  { key: 'maxExcess', label: 'Max Excess', title: 'Largest exceedance above 100 %, in pp', detail: true, align: 'right' },
  { key: 'meanExcess', label: 'Ø Excess', title: 'Mean exceedance in the overloaded scenarios, in pp', detail: true, align: 'right' },
  { key: 'lodf', label: 'Max |LODF|', title: 'Largest magnitude of the line outage distribution factor' },
  { key: 'lodfScenario', label: 'Largest influence', title: 'Scenario with the largest influence (highest |LODF|)' },
];

const STATUS_LABEL: Record<BandId, string> = { ok: 'OK', high: 'High', light: 'Light', clear: 'Clear', severe: 'Strong' };

function sortValue(s: LineStats, key: SortKey, codeOf: (id: string | null) => string | null): number | string | null {
  switch (key) {
    case 'name': return s.line.name;
    case 'base': return s.base;
    case 'min': return s.min;
    case 'max': return s.max;
    case 'delta': return s.maxDelta === null ? null : Math.abs(s.maxDelta);
    case 'spread': return s.spread;
    case 'n100': return s.n100;
    case 'n110': return s.n110;
    case 'n120': return s.n120;
    case 'rate': return s.overloadShare;
    case 'sumExcess': return s.sumExcess;
    case 'maxExcess': return s.maxExcess;
    case 'meanExcess': return s.meanExcess;
    case 'lodf': return s.maxAbsLodf;
    case 'maxScenario': return codeOf(s.maxScenarioId);
    case 'lodfScenario': return codeOf(s.lodfScenarioId);
    case 'status': return severityIndex(s) * 1e6 + s.priority;
  }
}

interface Props {
  lines: LineStats[];
  scenarios: ScenarioStats[];
  hasLodf: boolean;
  periodHours: number;
}

const PAGE = 25;

const scenarioCount = (count: number) => `${count} scenario${count === 1 ? '' : 's'}`;

/** Where a line's overloads come from: the outage itself, or the load it already carried. */
function CauseNotes({ counts }: { counts: { caused: number; preexisting: number } }) {
  return (
    <>
      {counts.caused > 0 && <span className="ab-sub">Caused by the outage in {scenarioCount(counts.caused)}</span>}
      {counts.preexisting > 0 && <span className="ab-sub">Pre-existing load in {scenarioCount(counts.preexisting)}</span>}
    </>
  );
}

export default function LineSummaryTable({ lines, scenarios, hasLodf, periodHours }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'status', dir: 'desc' });
  const [query, setQuery] = useState('');
  const [onlyRelevant, setOnlyRelevant] = useState(false);
  const [details, setDetails] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  const stats = useMemo(() => new Map(scenarios.map((s) => [s.scenario.id, s])), [scenarios]);
  const scenarioIds = useMemo(() => scenarios.map((s) => s.scenario.id), [scenarios]);
  const codeOf = useCallback((id: string | null) => (id ? stats.get(id)?.code ?? null : null), [stats]);
  const scales = useMemo(() => ({
    rate: Math.max(0.1, ...lines.map((s) => s.overloadShare)),
    loading: Math.max(LOADING_LIMITS.severe, ...lines.map((s) => s.max ?? 0)),
    excess: Math.max(1, ...lines.map((s) => s.sumExcess)),
    delta: Math.max(10, ...lines.map((s) => Math.abs(s.maxDelta ?? 0))),
    spread: Math.max(10, ...lines.map((s) => s.spread ?? 0)),
    lodf: Math.max(0.3, ...lines.map((s) => s.maxAbsLodf ?? 0)),
  }), [lines]);

  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('en');
    const filtered = lines.filter((s) =>
      (!needle || s.line.name.toLocaleLowerCase('en').includes(needle)) &&
      (!onlyRelevant || s.n100 > 0 || s.pattern !== null));
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const x = sortValue(a, sort.key, codeOf);
      const y = sortValue(b, sort.key, codeOf);
      if (x === null && y === null) return 0;
      if (x === null) return 1; // missing values always last
      if (y === null) return -1;
      return (typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y, 'en') : (x as number) - (y as number)) * sign;
    });
  }, [lines, query, onlyRelevant, sort, codeOf]);

  const columns = COLUMNS.filter((c) => details || !c.detail);
  const tag = (id: string | null) => {
    const s = id ? stats.get(id) : undefined;
    return s ? <ScenarioTag code={s.code} scenario={s.scenario} /> : null;
  };
  const toggle = (key: SortKey) =>
    setSort((cur) => cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' });

  return (
    <SectionCard
      collapsible
      defaultOpen
      id={SUMMARY_IDS.table}
      title="Detail table: equipment across all scenarios"
      summary={`${lines.length} equipment items (lines, transformers) with all key figures, sortable. Click to expand.`}
      hint="One row per equipment. Column headers sort; the bars complement the exact values. Δ in percentage points (pp) against REF in the same outage window. Overload rate = time above 100 % relative to the simulation period."
      actions={<>
        <input type="search" className="ab-control" style={{ width: '9.5rem' }} placeholder="Filter equipment" aria-label="Filter equipment" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }} />
        <label className="ab-toggle"><input type="checkbox" className="accent-[var(--grid-primary)]" checked={onlyRelevant} onChange={(e) => { setOnlyRelevant(e.target.checked); setLimit(PAGE); }} />conspicuous only</label>
        <label className="ab-toggle"><input type="checkbox" className="accent-[var(--grid-primary)]" checked={details} onChange={(e) => setDetails(e.target.checked)} />Excess details</label>
      </>}
    >
      <div className="ab-scroll ab-table-wide">
        <table className="ab-table ab-line-summary">
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th
                  key={c.key}
                  scope="col"
                  className={`${i === 0 ? 'ab-sticky' : ''} ${c.align === 'right' ? 'ab-num' : ''}`}
                  title={c.title}
                  aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  <button type="button" className="ab-sort" onClick={() => toggle(c.key)}>
                    {c.label}
                    <span className="ab-sort__arrow" aria-hidden>{sort.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((s) => {
              const maxBand = s.max === null ? null : bandOf(s.max).id;
              return (
                <tr key={s.line.id}>
                  <td className="ab-sticky"><div className="ab-linename" title={equipmentTitle(s.line.type, s.line.name)}>
                    <EquipmentName type={s.line.type} name={s.line.name} />
                  </div></td>
                  <td>
                    <div className="ab-status">
                      {s.band && <span className={`ab-badge ab-fill--${s.band} ab-ink--${s.band}`} title={s.max === null ? undefined : `Max Loading ${fmtNum(s.max)} %`}>{STATUS_LABEL[s.band]}</span>}
                      {s.pattern && <span className="ab-sub">{PATTERN_LABELS[s.pattern]}</span>}
                      <CauseNotes counts={causeCounts(s.line, scenarioIds)} />
                    </div>
                  </td>
                  <td className="ab-num">{fmtPct(s.base)}</td>
                  <td className="ab-num">{fmtPct(s.min)}</td>
                  <td>
                    {s.max === null ? '–' : (
                      <DataBar value={s.max} scale={scales.loading} text={fmtPct(s.max)} color={bandVar(maxBand!)} strong={s.max > LOADING_LIMITS.overload}
                        title={`Max Loading ${fmtPct(s.max)}`} />
                    )}
                  </td>
                  <td>{tag(s.maxScenarioId) ?? '–'}</td>
                  <td>
                    {s.maxDelta === null ? '–' : (
                      <DivergingBar value={s.maxDelta} scale={scales.delta} text={fmtPp(s.maxDelta)} strong={Math.abs(s.maxDelta) >= ANALYSIS.deltaStrongPp}
                        title={`${codeOf(s.maxDeltaScenarioId) ?? ''} · − reduction of loading, + increase of loading`} />
                    )}
                  </td>
                  <td>
                    {s.spread === null ? '–' : (
                      <DataBar value={s.spread} scale={scales.spread} text={fmtExcess(s.spread)} color="var(--ab-pos)" strong={s.spread >= ANALYSIS.deltaStrongPp} />
                    )}
                  </td>
                  <td className="ab-num">{s.n100}</td>
                  <td className="ab-num">{s.n110}</td>
                  <td className="ab-num">{s.n120}</td>
                  <td>
                    <DataBar value={s.overloadShare} scale={scales.rate} text={fmtShare(s.overloadShare)} color={bandVar(maxBand ?? 'ok')} strong={s.overloadHours > 0}
                      title={s.overloadHours > 0 ? `${fmtHours(s.overloadHours)} above 100 % in ${codeOf(s.overloadScenarioId) ?? 'one scenario'}` : 'no overload'} />
                    <span className="ab-sub">{fmtHours(s.overloadHours)} of {fmtHours(periodHours)}{s.overloadScenarioId ? ` · ${codeOf(s.overloadScenarioId)}` : ''}</span>
                  </td>
                  <td>
                    <DataBar value={s.sumExcess} scale={scales.excess} text={fmtExcess(s.sumExcess)} color={bandVar(maxBand ?? 'ok')} strong={s.sumExcess > 0}
                      title="Sum of max(loading − 100 %, 0) over all scenarios" />
                  </td>
                  {details && <td className="ab-num">{fmtExcess(s.maxExcess)}</td>}
                  {details && <td className="ab-num">{s.meanExcess === null ? '–' : fmtExcess(s.meanExcess)}</td>}
                  <td>
                    {s.maxAbsLodf === null ? <span className="ab-sub">{hasLodf ? '–' : 'not calculated'}</span> : (
                      <DataBar value={s.maxAbsLodf} scale={scales.lodf} text={fmtLodf(s.maxAbsLodf)} color="var(--ab-lodf)" strong={s.maxAbsLodf >= ANALYSIS.lodfNotable} />
                    )}
                  </td>
                  <td>{tag(s.lodfScenarioId) ?? '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-[var(--grid-muted)]">
        <span>{Math.min(limit, rows.length)} of {rows.length} equipment items</span>
        {rows.length > limit && (
          <button type="button" className="ab-chip" onClick={() => setLimit((n) => n + PAGE)}>Show {Math.min(PAGE, rows.length - limit)} more</button>
        )}
      </div>
    </SectionCard>
  );
}
