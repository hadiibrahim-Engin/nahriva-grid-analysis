import { useMemo, useState } from 'react';
import { ANALYSIS, bandOf } from '../../config/loadingBands';
import {
  fmtHours,
  fmtLodf,
  fmtNum,
  fmtPp,
  fmtPct,
  type LineStats,
  type ScenarioStats,
  SUMMARY_IDS,
} from '../../util/acrossScenarios';
import { CAUSE_LABEL, causeOf, equipmentTitle } from '../../util/outageAssessment';
import EquipmentName from './EquipmentName';
import { BandLegend, ScenarioTag, SectionCard } from './shared';

interface Props {
  lines: LineStats[];
  scenarios: ScenarioStats[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

type SortMode = 'priority' | 'max' | 'name';
const ROW_OPTIONS = [10, 12, 15, 20, 40, 0] as const; // 0 = all

export default function LineScenarioHeatmap({ lines, scenarios, selectedId, onSelect }: Props) {
  const [sort, setSort] = useState<SortMode>('priority');
  const [rowCount, setRowCount] = useState<number>(ANALYSIS.heatmapDefaultRows);
  const [query, setQuery] = useState('');
  const [onlyOverloaded, setOnlyOverloaded] = useState(false);

  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('en');
    let rows = lines.filter((s) => (!needle || s.line.name.toLocaleLowerCase('en').includes(needle)) && (!onlyOverloaded || s.n100 > 0));
    rows = [...rows].sort((a, b) =>
      sort === 'name' ? a.line.name.localeCompare(b.line.name, 'en')
      : sort === 'max' ? (b.max ?? -Infinity) - (a.max ?? -Infinity)
      : b.priority - a.priority);
    return { total: rows.length, rows: rowCount === 0 ? rows : rows.slice(0, rowCount) };
  }, [lines, sort, rowCount, query, onlyOverloaded]);

  return (
    <SectionCard
      id={SUMMARY_IDS.heatmap}
      title="Equipment × scenario heatmap"
      hint="Maximum loading in the outage window of the scenario, for lines and transformers (T). Base = REF maximum over the whole period. Outline: overload caused or aggravated by the outage (solid) or pre-existing load (dashed). By default the most conspicuous equipment."
      actions={<>
        <input
          type="search" className="ab-control" style={{ width: '9.5rem' }} placeholder="Filter equipment"
          aria-label="Filter equipment" value={query} onChange={(e) => setQuery(e.target.value)}
        />
        <label className="ab-toggle">
          <input type="checkbox" checked={onlyOverloaded} onChange={(e) => setOnlyOverloaded(e.target.checked)} className="accent-[var(--grid-primary)]" />
          overloaded only
        </label>
        <select className="ab-control" aria-label="Sort order" value={sort} onChange={(e) => setSort(e.target.value as SortMode)}>
          <option value="priority">Conspicuousness</option>
          <option value="max">Max Loading</option>
          <option value="name">Name</option>
        </select>
        <select className="ab-control" aria-label="Number of equipment" value={rowCount} onChange={(e) => setRowCount(Number(e.target.value))}>
          {ROW_OPTIONS.map((n) => <option key={n} value={n}>{n === 0 ? 'All equipment' : `Top ${n}`}</option>)}
        </select>
      </>}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <BandLegend />
          <span className="ab-legend" aria-label="Outline">
            <span className="ab-swatch ab-cell--caused" /> <span className="ab-legend__label">caused / aggravated</span>
            <span className="ab-swatch ab-cell--pre" style={{ marginLeft: 8 }} /> <span className="ab-legend__label">Pre-existing load</span>
          </span>
        </span>
        <span className="text-[11px] text-[var(--grid-muted)]">{shown.rows.length} of {shown.total} equipment items</span>
      </div>
      {shown.rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--grid-muted)]">No equipment matches the filter.</p>
      ) : (
        <div className="ab-scroll" style={{ padding: 4 }}>
          <table className="ab-heat" style={{ minWidth: `calc(20rem + ${scenarios.length * 5.5}rem)` }}>
            <colgroup>
              <col style={{ width: '15rem' }} />
              <col style={{ width: '5.5rem' }} />
              {scenarios.map((s) => <col key={s.scenario.id} />)}
            </colgroup>
            <thead>
              <tr>
                <th className="ab-heat__line" scope="col">Equipment</th>
                <th scope="col" title="REF maximum over the whole period">Base</th>
                {scenarios.map((s) => (
                  <th key={s.scenario.id} scope="col">
                    <button type="button" className="ab-heat__colbtn" aria-pressed={selectedId === s.scenario.id} onClick={() => onSelect(s.scenario.id)} title={s.scenario.name}>
                      <ScenarioTag code={s.code} scenario={s.scenario} />
                      <span className="ab-heat__colname">{s.scenario.name.replace(/^Outage\s+/, '')}</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.rows.map((stats) => (
                <tr key={stats.line.id}>
                  <td className="ab-heat__line" title={equipmentTitle(stats.line.type, stats.line.name)}>
                    <EquipmentName type={stats.line.type} name={stats.line.name} />
                  </td>
                  <td
                    className={`ab-heat__cell ab-heat__cell--base ${stats.base === null ? 'ab-heat__cell--none' : `ab-fill--${bandOf(stats.base).id} ab-ink--${bandOf(stats.base).id}`}`}
                    title={`Base (REF-Maximum): ${fmtPct(stats.base)}`}
                  >
                    {stats.base === null ? '–' : fmtNum(stats.base)}
                  </td>
                  {scenarios.map((s) => {
                    const cell = stats.line.cells[s.scenario.id];
                    if (!cell) return <td key={s.scenario.id} className="ab-heat__cell ab-heat__cell--none">–</td>;
                    if (cell.outaged) {
                      return <td key={s.scenario.id} className="ab-heat__cell ab-heat__cell--off" title={`${stats.line.name} is switched off in ${s.scenario.name}`}>OFF</td>;
                    }
                    if (cell.value === null) return <td key={s.scenario.id} className="ab-heat__cell ab-heat__cell--none">–</td>;
                    const band = bandOf(cell.value);
                    const cause = causeOf(cell);
                    const tip = [
                      `${stats.line.name} · ${s.code} ${s.scenario.name}`,
                      `Loading: ${fmtPct(cell.value)} (${band.label})`,
                      `REF in the same window: ${fmtPct(cell.window_base)}`,
                      `Δ Loading: ${fmtPp(cell.delta)}`,
                      `Time > 100 %: ${cell.hours_over ? fmtHours(cell.hours_over[0]) : '–'}`,
                      `LODF: ${fmtLodf(cell.lodf)}`,
                      cause ? CAUSE_LABEL[cause] : '',
                    ].filter(Boolean).join('\n');
                    return (
                      <td key={s.scenario.id} className={`ab-heat__cell ab-fill--${band.id} ab-ink--${band.id}${cause === 'preexisting' ? ' ab-cell--pre' : cause ? ' ab-cell--caused' : ''}`} title={tip}>
                        {fmtNum(cell.value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
