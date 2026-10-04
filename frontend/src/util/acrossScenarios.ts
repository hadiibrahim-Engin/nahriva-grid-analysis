/**
 * Pure calculations for the across-scenarios evaluation. Works on the read-only
 * payload of GET /api/simulation/across-scenarios; nothing here changes how
 * results are calculated or stored.
 */
import {
  ANALYSIS,
  BAND_ORDER,
  LOADING_LIMITS,
  bandIndex,
  bandOf,
  excessOf,
  type BandId,
} from '../config/loadingBands.ts';

export interface AcrossCell {
  outaged: boolean;
  value: number | null;
  window_base: number | null;
  delta: number | null;
  lodf: number | null;
  /** Hours above each limit of AcrossData.limits (100, 110, 120 %) in the whole simulation period. */
  hours_over: number[] | null;
}

export interface AcrossLine {
  id: string;
  name: string;
  class_name: string | null;
  type: string;
  /** PowerFactory grid (ElmNet), '' when the element has none; absent from older servers. */
  grid?: string | null;
  base: number | null;
  cells: Record<string, AcrossCell>;
}

/** Voltage of one busbar in one scenario: min/max in p.u. inside the outage windows. */
export interface AcrossBusCell {
  outaged: boolean;
  ref: [number, number] | null;
  out: [number, number] | null;
  /** Hours outside the stored voltage band over the whole simulation period. */
  hours_outside: number | null;
}

export interface AcrossBus {
  id: string;
  name: string;
  class_name: string | null;
  type: string;
  grid?: string | null;
  /** Unit of the stored voltage results, e.g. 'p.u.' or 'kV'. */
  unit?: string | null;
  /** [lower, upper] as stored with the results; null when none were stored. */
  limits: [number | null, number | null] | null;
  cells: Record<string, AcrossBusCell>;
}

export interface AcrossOutage {
  id: string;
  name: string;
  equipment_name: string | null;
  start: number | null;
  end: number | null;
}

export interface AcrossScenario {
  id: string;
  name: string;
  outages: AcrossOutage[];
  outaged_element_ids: string[];
  has_lodf: boolean;
}

export interface AcrossData {
  scenarios: AcrossScenario[];
  lines: AcrossLine[];
  /** Busbars, evaluated by voltage. Absent in databases written before voltage evaluation. */
  buses?: AcrossBus[];
  has_lodf: boolean;
  /** Length of the simulation period in hours; the denominator of every overload rate. */
  period_hours: number;
  /** [start, end] of the simulation period in epoch seconds, when known. */
  period?: [number, number] | null;
  limits: number[];
}

export type PatternId =
  | 'single-extreme'
  | 'frequent-light'
  | 'frequent-strong'
  | 'strong-change'
  | 'high-constant'
  | 'lodf-driven';

export const PATTERN_LABELS: Record<PatternId, string> = {
  'single-extreme': 'Single outlier',
  'frequent-light': 'Often lightly overloaded',
  'frequent-strong': 'Often strongly overloaded',
  'strong-change': 'Strong change without overload',
  'high-constant': 'High, independent of the scenario',
  'lodf-driven': 'High LODF with a large change',
};

export interface LineStats {
  line: AcrossLine;
  base: number | null;
  min: number | null;
  max: number | null;
  maxScenarioId: string | null;
  /** Signed change with the largest magnitude against the like-for-like REF value, in pp. */
  maxDelta: number | null;
  maxDeltaScenarioId: string | null;
  /** Largest minus smallest scenario loading, in pp. */
  spread: number | null;
  inService: number;
  n100: number;
  n110: number;
  n120: number;
  /** Share of all scenarios with a value above 100 %. */
  scenarioShare: number;
  /** Hours above 100 % in the worst scenario, and the same for 110 / 120 %. */
  overloadHours: number;
  overloadHoursBands: [number, number, number];
  overloadScenarioId: string | null;
  /** Overload Rate: time above 100 % in the worst scenario / simulation period (0..1). */
  overloadShare: number;
  maxExcess: number;
  meanExcess: number | null;
  sumExcess: number;
  maxAbsLodf: number | null;
  lodfScenarioId: string | null;
  band: BandId | null;
  pattern: PatternId | null;
  priority: number;
}

export interface ScenarioStats {
  scenario: AcrossScenario;
  code: string;
  counts: Record<BandId, number>;
  total: number;
  n100: number;
  n110: number;
  n120: number;
  maxValue: number | null;
  maxLine: AcrossLine | null;
  maxDelta: number | null;
  maxDeltaLine: AcrossLine | null;
  maxAbsLodf: number | null;
  maxLodfLine: AcrossLine | null;
  /** Longest time above 100 % of any line in this scenario, in hours. */
  longestOverloadHours: number;
  longestOverloadLine: AcrossLine | null;
  /** Lines whose loading changes by at least ANALYSIS.affectedDeltaPp in this scenario. */
  affected: number;
}

export function scenarioCode(index: number): string {
  return 'S' + String(index + 1).padStart(2, '0');
}

function usable(cell: AcrossCell | undefined): cell is AcrossCell & { value: number } {
  return !!cell && !cell.outaged && cell.value !== null && Number.isFinite(cell.value);
}

export function lineStats(line: AcrossLine, scenarios: readonly AcrossScenario[], periodHours = 0): LineStats {
  let max: number | null = null;
  let min: number | null = null;
  let maxScenarioId: string | null = null;
  let maxDelta: number | null = null;
  let maxDeltaScenarioId: string | null = null;
  let maxAbsLodf: number | null = null;
  let lodfScenarioId: string | null = null;
  let inService = 0;
  let n100 = 0;
  let n110 = 0;
  let n120 = 0;
  let sumExcess = 0;
  let maxExcess = 0;
  let overloadHours = 0;
  let overloadBands: [number, number, number] = [0, 0, 0];
  let overloadScenarioId: string | null = null;
  for (const scenario of scenarios) {
    const cell = line.cells[scenario.id];
    if (!cell) continue;
    if (usable(cell)) {
      inService += 1;
      if (max === null || cell.value > max) { max = cell.value; maxScenarioId = scenario.id; }
      if (min === null || cell.value < min) min = cell.value;
      if (cell.value > LOADING_LIMITS.overload) n100 += 1;
      if (cell.value > LOADING_LIMITS.clear) n110 += 1;
      if (cell.value > LOADING_LIMITS.severe) n120 += 1;
      if (cell.hours_over && cell.hours_over[0] > overloadHours) {
        overloadHours = cell.hours_over[0];
        overloadBands = [cell.hours_over[0], cell.hours_over[1] ?? 0, cell.hours_over[2] ?? 0];
        overloadScenarioId = scenario.id;
      }
      const excess = excessOf(cell.value);
      sumExcess += excess;
      maxExcess = Math.max(maxExcess, excess);
      if (cell.delta !== null && (maxDelta === null || Math.abs(cell.delta) > Math.abs(maxDelta))) {
        maxDelta = cell.delta;
        maxDeltaScenarioId = scenario.id;
      }
    }
    if (cell.lodf !== null && (maxAbsLodf === null || Math.abs(cell.lodf) > maxAbsLodf)) {
      maxAbsLodf = Math.abs(cell.lodf);
      lodfScenarioId = scenario.id;
    }
  }
  const total = scenarios.length;
  const scenarioShare = total > 0 ? n100 / total : 0;
  const spread = max !== null && min !== null ? max - min : null;
  const stats: LineStats = {
    line,
    base: line.base,
    min,
    max,
    maxScenarioId,
    maxDelta,
    maxDeltaScenarioId,
    spread,
    inService,
    n100,
    n110,
    n120,
    scenarioShare,
    overloadHours,
    overloadHoursBands: overloadBands,
    overloadScenarioId,
    overloadShare: periodHours > 0 ? Math.min(overloadHours / periodHours, 1) : 0,
    maxExcess,
    meanExcess: n100 > 0 ? sumExcess / n100 : null,
    sumExcess,
    maxAbsLodf,
    lodfScenarioId,
    band: max === null ? null : bandOf(max).id,
    pattern: null,
    priority: 0,
  };
  stats.pattern = patternOf(stats);
  stats.priority = priorityOf(stats);
  return stats;
}

/** The single most telling pattern of a line, or null when nothing stands out. */
export function patternOf(s: LineStats): PatternId | null {
  const a = ANALYSIS;
  if (s.n100 >= 1 && s.scenarioShare >= a.frequentScenarioShare) {
    return (s.max ?? 0) > LOADING_LIMITS.clear ? 'frequent-strong' : 'frequent-light';
  }
  if (s.n100 === 1 && (s.max ?? 0) > LOADING_LIMITS.clear) return 'single-extreme';
  if (s.maxAbsLodf !== null && s.maxAbsLodf >= a.lodfNotable && s.maxDelta !== null && Math.abs(s.maxDelta) >= a.deltaStrongPp / 2) return 'lodf-driven';
  if (s.n100 === 0 && s.maxDelta !== null && Math.abs(s.maxDelta) >= a.deltaStrongPp) return 'strong-change';
  if (
    s.n100 === 0 && s.max !== null && s.max >= LOADING_LIMITS.warning &&
    s.spread !== null && s.spread < a.spreadIndependentPp
  ) return 'high-constant';
  return null;
}

export function priorityOf(s: LineStats): number {
  const w = ANALYSIS.priorityWeights;
  return (
    w.maxExcess * s.maxExcess +
    w.sumExcess * s.sumExcess +
    w.overloadTime * s.overloadShare +
    w.highLoading * Math.max((s.max ?? 0) - LOADING_LIMITS.warning, 0) +
    w.absDelta * Math.abs(s.maxDelta ?? 0) +
    w.lodf * (s.maxAbsLodf ?? 0)
  );
}

export function scenarioStats(
  scenario: AcrossScenario,
  index: number,
  lines: readonly AcrossLine[],
): ScenarioStats {
  const counts = Object.fromEntries(BAND_ORDER.map((id) => [id, 0])) as Record<BandId, number>;
  const stats: ScenarioStats = {
    scenario,
    code: scenarioCode(index),
    counts,
    total: 0,
    n100: 0,
    n110: 0,
    n120: 0,
    maxValue: null,
    maxLine: null,
    maxDelta: null,
    maxDeltaLine: null,
    maxAbsLodf: null,
    maxLodfLine: null,
    longestOverloadHours: 0,
    longestOverloadLine: null,
    affected: 0,
  };
  for (const line of lines) {
    const cell = line.cells[scenario.id];
    if (!cell) continue;
    if (usable(cell)) {
      stats.total += 1;
      counts[bandOf(cell.value).id] += 1;
      if (cell.value > LOADING_LIMITS.overload) stats.n100 += 1;
      if (cell.value > LOADING_LIMITS.clear) stats.n110 += 1;
      if (cell.value > LOADING_LIMITS.severe) stats.n120 += 1;
      if (cell.hours_over && cell.hours_over[0] > stats.longestOverloadHours) {
        stats.longestOverloadHours = cell.hours_over[0];
        stats.longestOverloadLine = line;
      }
      if (stats.maxValue === null || cell.value > stats.maxValue) { stats.maxValue = cell.value; stats.maxLine = line; }
      if (cell.delta !== null && Math.abs(cell.delta) >= ANALYSIS.affectedDeltaPp) stats.affected += 1;
      if (cell.delta !== null && (stats.maxDelta === null || Math.abs(cell.delta) > Math.abs(stats.maxDelta))) {
        stats.maxDelta = cell.delta;
        stats.maxDeltaLine = line;
      }
    }
    if (cell.lodf !== null && (stats.maxAbsLodf === null || Math.abs(cell.lodf) > stats.maxAbsLodf)) {
      stats.maxAbsLodf = Math.abs(cell.lodf);
      stats.maxLodfLine = line;
    }
  }
  return stats;
}

/** Most critical first: strong overloads, then clear overloads, then all overloads, then peak value. */
export function compareScenarioCriticality(a: ScenarioStats, b: ScenarioStats): number {
  return (
    b.n120 - a.n120 ||
    b.n110 - a.n110 ||
    b.n100 - a.n100 ||
    (b.maxValue ?? -Infinity) - (a.maxValue ?? -Infinity)
  );
}

export interface Extreme<T = AcrossLine> {
  value: number;
  line: T;
  scenarioId: string | null;
}

export interface AcrossKpis {
  scenarioCount: number;
  scenariosOverloaded: number;
  linesOverloaded: number;
  linesRecurring: number;
  maxLoading: Extreme | null;
  maxChange: Extreme | null;
  maxLodf: Extreme | null;
  /** Longest overload of a line in one scenario, relative to the simulation period. */
  longestOverload: (Extreme & { share: number }) | null;
  periodHours: number;
  criticalScenario: ScenarioStats | null;
}

export function kpis(
  lineStatList: readonly LineStats[],
  scenarioStatList: readonly ScenarioStats[],
  periodHours = 0,
): AcrossKpis {
  let longestOverload: (Extreme & { share: number }) | null = null;
  let maxLoading: Extreme | null = null;
  let maxChange: Extreme | null = null;
  let maxLodf: Extreme | null = null;
  for (const s of lineStatList) {
    if (s.max !== null && (maxLoading === null || s.max > maxLoading.value)) {
      maxLoading = { value: s.max, line: s.line, scenarioId: s.maxScenarioId };
    }
    if (s.maxDelta !== null && (maxChange === null || Math.abs(s.maxDelta) > Math.abs(maxChange.value))) {
      maxChange = { value: s.maxDelta, line: s.line, scenarioId: s.maxDeltaScenarioId };
    }
    if (s.overloadHours > 0 && (longestOverload === null || s.overloadHours > longestOverload.value)) {
      longestOverload = { value: s.overloadHours, line: s.line, scenarioId: s.overloadScenarioId, share: s.overloadShare };
    }
    if (s.maxAbsLodf !== null && (maxLodf === null || s.maxAbsLodf > maxLodf.value)) {
      maxLodf = { value: s.maxAbsLodf, line: s.line, scenarioId: s.lodfScenarioId };
    }
  }
  const sorted = [...scenarioStatList].sort(compareScenarioCriticality);
  return {
    scenarioCount: scenarioStatList.length,
    scenariosOverloaded: scenarioStatList.filter((s) => s.n100 > 0).length,
    linesOverloaded: lineStatList.filter((s) => s.n100 > 0).length,
    linesRecurring: lineStatList.filter((s) => s.n100 >= ANALYSIS.recurringMinScenarios).length,
    maxLoading,
    maxChange,
    maxLodf,
    longestOverload,
    periodHours,
    criticalScenario: sorted[0] && sorted[0].n100 > 0 ? sorted[0] : null,
  };
}

export function analyse(data: AcrossData) {
  const lines = data.lines.map((line) => lineStats(line, data.scenarios, data.period_hours));
  const scenarios = data.scenarios.map((scenario, index) => scenarioStats(scenario, index, data.lines));
  return { lines, scenarios, kpis: kpis(lines, scenarios, data.period_hours) };
}

export function severityIndex(stats: LineStats): number {
  return stats.band === null ? -1 : bandIndex(stats.band);
}

// -- Formatting ---------------------------------------------------------------

const nf1 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

export const fmtPct = (v: number | null | undefined): string => v == null ? '–' : `${nf1.format(v)} %`;
export const fmtNum = (v: number | null | undefined): string => v == null ? '–' : nf1.format(v);
export const fmtPp = (v: number | null | undefined): string =>
  v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${nf1.format(Math.abs(v))} pp`;
export const fmtExcess = (v: number | null | undefined): string => v == null ? '–' : `${nf1.format(v)} pp`;
export const fmtLodf = (v: number | null | undefined): string => v == null ? '–' : nf2.format(v);
export const fmtShare = (v: number): string => `${nf1.format(v * 100)} %`;
export const fmtHours = (h: number | null | undefined): string => h == null ? '–' : `${nf1.format(h)} h`;
/** Length of the simulation period, e.g. "7 days" or "36 h". */
export const fmtPeriod = (hours: number): string =>
  hours >= 48 ? `${nf0.format(Math.round((hours / 24) * 10) / 10)} days` : `${nf0.format(hours)} h`;

// -- Navigation of the summary ----------------------------------------------

export const SUMMARY_IDS = {
  kpis: 'across-kpis',
  radar: 'across-radar',
  overview: 'across-overview',
  profile: 'across-profile',
  charts: 'across-charts',
  heatmap: 'across-heatmap',
  voltage: 'across-voltage',
  table: 'across-table',
  details: 'across-details',
} as const;

export interface SummarySection {
  id: string;
  label: string;
  /** Short qualifier shown next to the label, e.g. the number of scenarios. */
  count?: number;
}

/** Sections of the summary in reading order; drives the detailed navigation bar. */
export function summarySections(
  a: { lines: readonly LineStats[]; scenarios: readonly ScenarioStats[] },
  busCount = 0,
): SummarySection[] {
  // Reading order of an outage assessment: result, chosen scenario, voltage, loading matrix, comparison, reference.
  return [
    { id: SUMMARY_IDS.kpis, label: 'Key figures' },
    { id: SUMMARY_IDS.overview, label: 'Assessment', count: a.scenarios.length },
    { id: SUMMARY_IDS.profile, label: 'Profile' },
    { id: SUMMARY_IDS.details, label: 'Scenario details' },
    ...(busCount > 0 ? [{ id: SUMMARY_IDS.voltage, label: 'Voltage', count: busCount }] : []),
    { id: SUMMARY_IDS.heatmap, label: 'Matrix', count: a.lines.length },
    { id: SUMMARY_IDS.charts, label: 'Comparison', count: 4 },
    { id: SUMMARY_IDS.radar, label: 'Radar' },
    { id: SUMMARY_IDS.table, label: 'Detail table' },
  ];
}

/** Collapsed cards listen for this event and open themselves, so navigation never lands on a closed section. */
export const OPEN_SECTION_EVENT = 'across:open';
export const openSection = (id: string): void => {
  window.dispatchEvent(new CustomEvent(OPEN_SECTION_EVENT, { detail: id }));
};
