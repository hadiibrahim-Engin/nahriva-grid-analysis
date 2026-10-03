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
import { EQUIPMENT_LABEL, EQUIPMENT_MARK, causeOf, equipmentKind } from '../../util/freischaltung';
import { DataBar, DivergingBar, ScenarioTag, SectionCard } from './shared';

type SortKey =
  | 'name' | 'base' | 'min' | 'max' | 'delta' | 'spread' | 'n100' | 'n110' | 'n120'
  | 'rate' | 'sumExcess' | 'maxExcess' | 'meanExcess' | 'lodf' | 'lodfScenario' | 'status' | 'maxScenario';

interface Column { key: SortKey; label: string; title: string; align?: 'right'; detail?: boolean }

const COLUMNS: Column[] = [
  { key: 'name', label: 'Betriebsmittel', title: 'Leitung (ohne Marke) oder Transformator (T)' },
  { key: 'status', label: 'Status', title: 'Schweregrad der größten Auslastung und erkanntes Muster' },
  { key: 'base', label: 'Base', title: 'Base Loading: REF-Maximum über den gesamten Zeitraum', align: 'right' },
  { key: 'min', label: 'Min', title: 'Kleinste Szenario-Auslastung (Betriebsmittel in Betrieb)', align: 'right' },
  { key: 'max', label: 'Max Loading', title: 'Größte Szenario-Auslastung' },
  { key: 'maxScenario', label: 'Szenario', title: 'Szenario bei Max Loading' },
  { key: 'delta', label: 'Max Δ Loading', title: 'Größte Änderung gegenüber REF im selben Ausfallfenster, in pp (Sortierung nach Betrag)' },
  { key: 'spread', label: 'Max Δ zw. Szenarien', title: 'Größte minus kleinste Szenario-Auslastung, in pp' },
  { key: 'n100', label: 'Szen. > 100 %', title: 'Anzahl Szenarien mit Loading > 100 %', align: 'right' },
  { key: 'n110', label: 'Szen. > 110 %', title: 'Anzahl Szenarien mit Loading > 110 %', align: 'right' },
  { key: 'n120', label: 'Szen. > 120 %', title: 'Anzahl Szenarien mit Loading > 120 %', align: 'right' },
  { key: 'rate', label: 'Overload Rate', title: 'Zeit über 100 % im ungünstigsten Szenario, bezogen auf den Simulationszeitraum' },
  { key: 'sumExcess', label: 'Sum Excess', title: 'Summe von max(Loading − 100 %, 0) über alle Szenarien, in pp' },
  { key: 'maxExcess', label: 'Max Excess', title: 'Größte Überschreitung über 100 %, in pp', detail: true, align: 'right' },
  { key: 'meanExcess', label: 'Ø Excess', title: 'Mittlere Überschreitung in den überlasteten Szenarien, in pp', detail: true, align: 'right' },
  { key: 'lodf', label: 'Max |LODF|', title: 'Größter Betrag des Line Outage Distribution Factors' },
  { key: 'lodfScenario', label: 'Größter Einfluss', title: 'Szenario mit dem größten Einfluss (höchster |LODF|)' },
];

const STATUS_LABEL: Record<BandId, string> = { ok: 'OK', high: 'Hoch', light: 'Leicht', clear: 'Deutlich', severe: 'Stark' };

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

export default function LineSummaryTable({ lines, scenarios, hasLodf, periodHours }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'status', dir: 'desc' });
  const [query, setQuery] = useState('');
  const [onlyRelevant, setOnlyRelevant] = useState(false);
  const [details, setDetails] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  const stats = useMemo(() => new Map(scenarios.map((s) => [s.scenario.id, s])), [scenarios]);
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
    const needle = query.trim().toLocaleLowerCase('de');
    const filtered = lines.filter((s) =>
      (!needle || s.line.name.toLocaleLowerCase('de').includes(needle)) &&
      (!onlyRelevant || s.n100 > 0 || s.pattern !== null));
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const x = sortValue(a, sort.key, codeOf);
      const y = sortValue(b, sort.key, codeOf);
      if (x === null && y === null) return 0;
      if (x === null) return 1; // missing values always last
      if (y === null) return -1;
      return (typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y, 'de') : (x as number) - (y as number)) * sign;
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
      title="Detailtabelle: Betriebsmittel über alle Szenarien"
      summary={`${lines.length} Betriebsmittel (Leitungen, Transformatoren) mit allen Kennzahlen, sortierbar. Zum Aufklappen klicken.`}
      hint="Eine Zeile je Betriebsmittel. Spaltenköpfe sortieren; die Balken ergänzen die exakten Werte. Δ in Prozentpunkten (pp) gegenüber REF im selben Ausfallfenster. Overload Rate = Zeit über 100 % bezogen auf den Simulationszeitraum."
      actions={<>
        <input type="search" className="ab-control" style={{ width: '9.5rem' }} placeholder="Betriebsmittel filtern" aria-label="Betriebsmittel filtern" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }} />
        <label className="ab-toggle"><input type="checkbox" className="accent-[var(--grid-primary)]" checked={onlyRelevant} onChange={(e) => { setOnlyRelevant(e.target.checked); setLimit(PAGE); }} />nur auffällige</label>
        <label className="ab-toggle"><input type="checkbox" className="accent-[var(--grid-primary)]" checked={details} onChange={(e) => setDetails(e.target.checked)} />Excess-Details</label>
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
                  <td className="ab-sticky"><div className="ab-linename" title={`${EQUIPMENT_LABEL[equipmentKind(s.line.type)]}: ${s.line.name}`}>
                    {EQUIPMENT_MARK[equipmentKind(s.line.type)] && <span className="ab-type" aria-label={EQUIPMENT_LABEL[equipmentKind(s.line.type)]}>{EQUIPMENT_MARK[equipmentKind(s.line.type)]}</span>}
                    {s.line.name}
                  </div></td>
                  <td>
                    <div className="ab-status">
                      {s.band && <span className={`ab-badge ab-fill--${s.band} ab-ink--${s.band}`} title={s.max === null ? undefined : `Max Loading ${fmtNum(s.max)} %`}>{STATUS_LABEL[s.band]}</span>}
                      {s.pattern && <span className="ab-sub">{PATTERN_LABELS[s.pattern]}</span>}
                      {(() => {
                        let caused = 0;
                        let pre = 0;
                        for (const sc of scenarios) {
                          const cause = causeOf(s.line.cells[sc.scenario.id]);
                          if (cause === 'caused' || cause === 'aggravated') caused += 1;
                          else if (cause === 'preexisting') pre += 1;
                        }
                        return (
                          <>
                            {caused > 0 && <span className="ab-sub">durch Freischaltung in {caused} Szenario{caused === 1 ? '' : 'en'}</span>}
                            {pre > 0 && <span className="ab-sub">Vorbelastung in {pre} Szenario{pre === 1 ? '' : 'en'}</span>}
                          </>
                        );
                      })()}
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
                        title={`${codeOf(s.maxDeltaScenarioId) ?? ''} · − Reduktion der Auslastung, + Erhöhung der Auslastung`} />
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
                      title={s.overloadHours > 0 ? `${fmtHours(s.overloadHours)} über 100 % in ${codeOf(s.overloadScenarioId) ?? 'einem Szenario'}` : 'keine Überlastung'} />
                    <span className="ab-sub">{fmtHours(s.overloadHours)} von {fmtHours(periodHours)}{s.overloadScenarioId ? ` · ${codeOf(s.overloadScenarioId)}` : ''}</span>
                  </td>
                  <td>
                    <DataBar value={s.sumExcess} scale={scales.excess} text={fmtExcess(s.sumExcess)} color={bandVar(maxBand ?? 'ok')} strong={s.sumExcess > 0}
                      title="Summe max(Loading − 100 %, 0) über alle Szenarien" />
                  </td>
                  {details && <td className="ab-num">{fmtExcess(s.maxExcess)}</td>}
                  {details && <td className="ab-num">{s.meanExcess === null ? '–' : fmtExcess(s.meanExcess)}</td>}
                  <td>
                    {s.maxAbsLodf === null ? <span className="ab-sub">{hasLodf ? '–' : 'nicht berechnet'}</span> : (
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
        <span>{Math.min(limit, rows.length)} von {rows.length} Betriebsmitteln</span>
        {rows.length > limit && (
          <button type="button" className="ab-chip" onClick={() => setLimit((n) => n + PAGE)}>Weitere {Math.min(PAGE, rows.length - limit)} anzeigen</button>
        )}
      </div>
    </SectionCard>
  );
}
