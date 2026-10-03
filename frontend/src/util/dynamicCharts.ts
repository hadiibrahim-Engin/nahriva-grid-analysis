/**
 * Shared types + pure helpers for the dynamic ("Add chart") workflow.
 *
 * These are framework-free so both the dashboard page and DynamicChartCard can
 * reuse them without pulling in chart runtimes. The peak-demand and correlation
 * builders mirror the logic already used by the fixed dashboard panels so a
 * generated card produces identical numbers.
 */
import type { CorrelationMethod, CorrelationScatterData, DurationCurveData, TimeseriesData } from '../api/client';
import type {
  PeakDemandContribution,
  PeakDemandPeriod,
  PeakDemandRow,
} from '../components/charts/PeakDemandChart';

/** A source signal the user has already added to the dashboard. */
export interface DashboardSeries {
  key: string;
  facilityName: string;
  facilityId: string;
  componentId: string;
  componentName: string;
  measurementType: string;
}

/** Persisted configuration for one generated chart card. */
export interface DynamicChartConfig {
  /** Ordered source series keys. [0] = primary, [1] = secondary (two-signal). */
  sourceKeys: string[];
  threshold?: number;
  /** Scenario evaluation charts: how many equipment items to show, and of which kind. */
  topN?: number;
  equipment?: 'all' | 'line' | 'transformer';
  /** Multiple warning/exceedance levels rendered as constant reference lines. */
  thresholdLevels?: number[];
  /** Display names for thresholdLevels, matched by index before sorting. */
  thresholdLevelNames?: string[];
  /** Display colors for thresholdLevels, matched by index before sorting. */
  thresholdLevelColors?: string[];
  /** Voltage compliance lower/upper limits, expressed as percent of nominal voltage. */
  voltageMinPct?: number;
  voltageMaxPct?: number;
  aggregation?: import('../api/client').AggregationFn;
  resolutionMinutes?: number;
  /** Y-axis scale mode. 'auto' (default) lets ECharts pick the range. */
  yAxisScaleType?: 'auto' | 'manual';
  yAxisMin?: number;
  yAxisMax?: number;
  /** Linear (default) or logarithmic Y-axis. */
  yAxisLog?: boolean;
  /** Histogram layout for multi-signal selections: one signal at a time
   * (dropdown) or all overlaid in one chart. Default 'single'. */
  histogramMode?: 'single' | 'combined';
  /** How the boxplot buckets its data. Default 'hour'. */
  boxplotGroupBy?: import('../api/client').BoxPlotGroupBy;
  /** Boxplot layout for multi-signal selections: one signal at a time
   * (dropdown) or all side-by-side in one chart. Default 'single'. */
  boxplotMode?: 'single' | 'combined';
  /** Which statistic correlation-family scatter charts use. Default 'pearson'
   * (fastest, linear-only); 'spearman'/'kendall' are rank-based. */
  correlationMethod?: import('../api/client').CorrelationMethod;
}

/** One generated chart instance on the dashboard. */
export interface DashboardChartConfig {
  id: string;
  templateId: string;
  config: DynamicChartConfig;
}

export interface ThresholdLevelEntry {
  value: number;
  name: string;
  color: string;
}

export function defaultThresholdLevelName(index: number, total: number): string {
  if (index === 0) return 'Warnung';
  if (index === total - 1) return 'Überschreitung';
  return `Stufe ${index + 1}`;
}

export function defaultThresholdLevelColor(index: number, total: number): string {
  if (index === 0) return '#f59e0b';
  if (index === total - 1) return '#ef4444';
  const middle = ['#22d3ee', '#22c55e', '#3b82f6', '#94a3b8'];
  return middle[(index - 1) % middle.length];
}

export function normalizeThresholdLevelColor(
  color: string | undefined,
  index: number,
  total: number,
): string {
  const raw = color?.trim() ?? '';
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  }
  return defaultThresholdLevelColor(index, total);
}

export function normalizeThresholdLevelEntries(
  levels: number[] | undefined,
  names: string[] | undefined,
  colors: string[] | undefined,
): ThresholdLevelEntry[] {
  const raw = (levels ?? [])
    .map((value, index) => ({
      value,
      rawName: names?.[index]?.trim() ?? '',
      rawColor: colors?.[index]?.trim() ?? '',
    }))
    .filter((entry) => Number.isFinite(entry.value))
    .sort((a, b) => a.value - b.value);

  const unique: { value: number; rawName: string; rawColor: string }[] = [];
  for (const entry of raw) {
    if (unique.some((item) => item.value === entry.value)) continue;
    unique.push(entry);
  }

  return unique.map((entry, index) => ({
    value: entry.value,
    name: entry.rawName || defaultThresholdLevelName(index, unique.length),
    color: normalizeThresholdLevelColor(entry.rawColor, index, unique.length),
  }));
}

export const MTYPE_LABELS: Record<string, string> = {
  L: 'Auslastung',
  LOSS: 'Verluste',
  P: 'Wirkleistung (P)',
  Q: 'Blindleistung (Q)',
  S: 'Scheinleistung (S)',
  U: 'Spannung (U)',
  I: 'Strom (I)',
};

export function seriesLabel(series: DashboardSeries): string {
  const measurement = MTYPE_LABELS[series.measurementType] ?? series.measurementType;
  return `${series.facilityName} / ${series.componentName} - ${measurement}`;
}

/**
 * Which physically-required measurements are missing for the chosen source(s).
 *
 * A chart whose calculation needs several measurements of the SAME component
 * (e.g. power factor needs P, Q, S) may only be generated once all of them are
 * loaded. This pure helper resolves the source keys to their component(s) and
 * returns the required measurement types that are not available for them.
 *
 * - `required` empty/undefined → never blocks (returns []).
 * - No source chosen yet → gate stays closed (returns all required).
 * - Multiple components selected → union of what's missing across them.
 */
export function missingRequiredMeasurements(
  required: string[] | undefined,
  sourceKeys: string[],
  availableSeries: DashboardSeries[],
): string[] {
  if (!required || required.length === 0) return [];
  const componentIds = new Set(
    sourceKeys
      .map((key) => availableSeries.find((s) => s.key === key)?.componentId)
      .filter((id): id is string => !!id),
  );
  if (componentIds.size === 0) return [...required];
  const missing = new Set<string>();
  componentIds.forEach((cid) => {
    const have = new Set(
      availableSeries.filter((s) => s.componentId === cid).map((s) => s.measurementType),
    );
    required.forEach((m) => { if (!have.has(m)) missing.add(m); });
  });
  return [...missing];
}

export function pearson(points: { x: number; y: number }[]): number {
  const n = points.length;
  if (n < 2) return 0;
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n;
  let numerator = 0;
  let varianceX = 0;
  let varianceY = 0;
  points.forEach((p) => {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    numerator += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  });
  const denominator = Math.sqrt(varianceX * varianceY);
  return denominator === 0 ? 0 : numerator / denominator;
}

/** 1-based ranks with ties averaged (standard rank-correlation convention). */
function rank(values: number[]): number[] {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && values[order[j + 1]] === values[order[i]]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k]] = avgRank;
    i = j + 1;
  }
  return ranks;
}

/** Spearman's rho: Pearson correlation of the ranks. Catches monotonic (not
 * just linear) relationships; O(n log n) from the rank sort. */
export function spearman(points: { x: number; y: number }[]): number {
  if (points.length < 2) return 0;
  const xRanks = rank(points.map((p) => p.x));
  const yRanks = rank(points.map((p) => p.y));
  return pearson(xRanks.map((x, i) => ({ x, y: yRanks[i] })));
}

/** Kendall's tau-b: fraction of concordant minus discordant pairs, corrected
 * for ties in each variable separately (tau-a would overstate |tau| when a
 * signal has repeated readings, common for sensor data). O(n^2) pairwise
 * comparison — fine for typical dashboard point counts, but the slowest of
 * the three methods on very large selections. */
export function kendallTau(points: { x: number; y: number }[]): number {
  const n = points.length;
  if (n < 2) return 0;
  let concordant = 0;
  let discordant = 0;
  let tiesX = 0;
  let tiesY = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = points[j].x - points[i].x;
      const dy = points[j].y - points[i].y;
      if (dx === 0 && dy === 0) continue;
      if (dx === 0) { tiesX++; continue; }
      if (dy === 0) { tiesY++; continue; }
      if (dx * dy > 0) concordant++; else discordant++;
    }
  }
  const totalPairs = (n * (n - 1)) / 2;
  const denominator = Math.sqrt((totalPairs - tiesX) * (totalPairs - tiesY));
  return denominator === 0 ? 0 : (concordant - discordant) / denominator;
}

export const CORRELATION_METHOD_LABELS: Record<CorrelationMethod, string> = {
  pearson: 'Pearson (linear)',
  spearman: 'Spearman (Rang, monoton)',
  kendall: 'Kendall (Rang, robust)',
};

export const CORRELATION_METHOD_SYMBOLS: Record<CorrelationMethod, string> = {
  pearson: 'r',
  spearman: 'ρ',
  kendall: 'τ',
};

export function correlationBy(method: CorrelationMethod, points: { x: number; y: number }[]): number {
  if (method === 'spearman') return spearman(points);
  if (method === 'kendall') return kendallTau(points);
  return pearson(points);
}

/** Builds the correlation scatter payload from two loaded series. Defaults to
 * Pearson (fastest, O(n)) when no method is given. */
export function buildCorrelation(
  xSeries: DashboardSeries,
  ySeries: DashboardSeries,
  xData: TimeseriesData,
  yData: TimeseriesData,
  method: CorrelationMethod = 'pearson',
): CorrelationScatterData {
  const yByTimestamp = new Map<string, number>();
  yData.data.forEach((point) => {
    if (Number.isFinite(point.value)) yByTimestamp.set(point.timestamp, point.value);
  });

  const points = xData.data
    .map((point) => {
      const y = yByTimestamp.get(point.timestamp);
      if (!Number.isFinite(point.value) || y == null || !Number.isFinite(y)) return null;
      return { x: point.value, y };
    })
    .filter((point): point is { x: number; y: number } => point !== null);

  if (points.length < 2) {
    throw new Error('Zu wenige gemeinsame Zeitpunkte für diese Korrelation. Prüfe Zeitraum oder Auflösung.');
  }

  const correlation = correlationBy(method, points);
  const direction = Math.abs(correlation) > 0.7
    ? 'starke'
    : Math.abs(correlation) > 0.4
      ? 'mittlere'
      : 'schwache';

  return {
    component_name: `${xSeries.componentName} ↔ ${ySeries.componentName}`,
    type_x: xSeries.measurementType,
    unit_x: xData.unit,
    type_y: ySeries.measurementType,
    unit_y: yData.unit,
    correlation,
    method,
    lag_minutes: 0,
    interpretation: `${direction} ${CORRELATION_METHOD_LABELS[method]}-Korrelation aus ${points.length.toLocaleString()} gemeinsamen Zeitpunkten.`,
    data: points,
  };
}

/** Correlation scatter data with a third variable to encode as point color. */
export interface CorrelationScatterData3 extends Omit<CorrelationScatterData, 'data'> {
  type_z: string;
  unit_z: string;
  data: { x: number; y: number; z: number }[];
}

/** Same X/Y correlation as `buildCorrelation`, plus a third series joined on
 * timestamp for color-encoding a point. The correlation is still only between
 * X and Y — the Z series is a visual dimension, not part of that statistic. */
export function buildCorrelation3(
  xSeries: DashboardSeries,
  ySeries: DashboardSeries,
  zSeries: DashboardSeries,
  xData: TimeseriesData,
  yData: TimeseriesData,
  zData: TimeseriesData,
  method: CorrelationMethod = 'pearson',
): CorrelationScatterData3 {
  const yByTimestamp = new Map<string, number>();
  yData.data.forEach((point) => {
    if (Number.isFinite(point.value)) yByTimestamp.set(point.timestamp, point.value);
  });
  const zByTimestamp = new Map<string, number>();
  zData.data.forEach((point) => {
    if (Number.isFinite(point.value)) zByTimestamp.set(point.timestamp, point.value);
  });

  const points = xData.data
    .map((point) => {
      const y = yByTimestamp.get(point.timestamp);
      const z = zByTimestamp.get(point.timestamp);
      if (!Number.isFinite(point.value) || y == null || !Number.isFinite(y) || z == null || !Number.isFinite(z)) {
        return null;
      }
      return { x: point.value, y, z };
    })
    .filter((point): point is { x: number; y: number; z: number } => point !== null);

  if (points.length < 2) {
    throw new Error('Zu wenige gemeinsame Zeitpunkte für diese Korrelation. Prüfe Zeitraum oder Auflösung.');
  }

  const correlation = correlationBy(method, points);
  const direction = Math.abs(correlation) > 0.7
    ? 'starke'
    : Math.abs(correlation) > 0.4
      ? 'mittlere'
      : 'schwache';

  return {
    component_name: `${xSeries.componentName} ↔ ${ySeries.componentName}`,
    type_x: xSeries.measurementType,
    unit_x: xData.unit,
    type_y: ySeries.measurementType,
    unit_y: yData.unit,
    type_z: zSeries.measurementType,
    unit_z: zData.unit,
    correlation,
    method,
    lag_minutes: 0,
    interpretation: `${direction} ${CORRELATION_METHOD_LABELS[method]}-Korrelation (X/Y) aus ${points.length.toLocaleString()} gemeinsamen Zeitpunkten, eingefärbt nach ${zSeries.measurementType}.`,
    data: points,
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isoWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return { year, week };
}

function peakPeriod(timestamp: string, period: PeakDemandPeriod): { key: string; label: string } {
  const d = new Date(timestamp);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  if (period === 'day') {
    const key = `${year}-${pad2(month)}-${pad2(d.getUTCDate())}`;
    return { key, label: key };
  }
  if (period === 'week') {
    const { year: weekYear, week } = isoWeek(d);
    return { key: `${weekYear}-W${pad2(week)}`, label: `KW ${pad2(week)}/${weekYear}` };
  }
  const key = `${year}-${pad2(month)}`;
  return { key, label: key };
}

/** Builds peak-demand rows (per period) by summing all P series at each timestamp. */
export function buildPeakRows(
  sources: DashboardSeries[],
  dataMap: Record<string, TimeseriesData>,
): Record<PeakDemandPeriod, PeakDemandRow[]> {
  const pointsByTimestamp = new Map<string, {
    timestamp: string;
    total: number;
    unit: string;
    contributions: Omit<PeakDemandContribution, 'percent'>[];
  }>();

  sources
    .filter((series) => series.measurementType === 'P')
    .forEach((series) => {
      const data = dataMap[series.key];
      if (!data) return;
      data.data.forEach((point) => {
        if (!Number.isFinite(point.value)) return;
        const entry = pointsByTimestamp.get(point.timestamp) ?? {
          timestamp: point.timestamp,
          total: 0,
          unit: data.unit,
          contributions: [],
        };
        entry.total += point.value;
        entry.contributions.push({
          key: series.key,
          label: `${series.facilityName} / ${series.componentName}`,
          value: point.value,
        });
        pointsByTimestamp.set(point.timestamp, entry);
      });
    });

  const grouped: Record<PeakDemandPeriod, Map<string, PeakDemandRow>> = {
    day: new Map(),
    week: new Map(),
    month: new Map(),
  };

  pointsByTimestamp.forEach((sample) => {
    (Object.keys(grouped) as PeakDemandPeriod[]).forEach((period) => {
      const { key, label } = peakPeriod(sample.timestamp, period);
      const current = grouped[period].get(key);
      if (current && current.value >= sample.total) return;
      const denominator = sample.total !== 0
        ? sample.total
        : sample.contributions.reduce((sum, c) => sum + Math.abs(c.value), 0) || 1;
      const contributions = sample.contributions
        .map((c) => ({ ...c, percent: (c.value / denominator) * 100 }))
        .sort((a, b) => b.value - a.value);
      grouped[period].set(key, {
        periodKey: key,
        periodLabel: label,
        timestamp: sample.timestamp,
        value: sample.total,
        unit: sample.unit,
        contributions,
      });
    });
  });

  return {
    day: Array.from(grouped.day.values()).sort((a, b) => a.periodKey.localeCompare(b.periodKey)),
    week: Array.from(grouped.week.values()).sort((a, b) => a.periodKey.localeCompare(b.periodKey)),
    month: Array.from(grouped.month.values()).sort((a, b) => a.periodKey.localeCompare(b.periodKey)),
  };
}

// -- Client-side derived charts -----------------------------------------------
// Pure transforms over already-loaded raw timeseries. They reuse the existing
// chart components (TimeseriesChart, DurationCurveChart, CorrelationChart) by
// producing the same data shapes those components already accept — so no new
// chart renderers are needed. Every transform skips non-finite values rather
// than treating them as 0 (consistent with the backend hardening).

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Hours between two ISO timestamps (0 if unparseable / non-positive). */
function hoursBetween(a: string, b: string): number {
  const dt = (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;
  return Number.isFinite(dt) && dt > 0 ? dt : 0;
}

/**
 * Cumulative energy ∫P dt (trapezoidal) → MWh series. P in MW, dt in hours.
 * The last value is the total energy over the window.
 */
export function buildEnergyIntegral(src: DashboardSeries, data: TimeseriesData): TimeseriesData {
  let cum = 0;
  const out = data.data.map((point, i) => {
    if (i > 0) {
      const prev = data.data[i - 1];
      const dtH = hoursBetween(prev.timestamp, point.timestamp);
      if (dtH > 0 && Number.isFinite(prev.value) && Number.isFinite(point.value)) {
        cum += ((prev.value + point.value) / 2) * dtH;
      }
    }
    return { timestamp: point.timestamp, value: r3(cum) };
  });
  return {
    ...data, component_name: src.componentName, measurement_type: 'E', unit: 'MWh', data: out,
  };
}

/** Aligned difference inSeries − outSeries on shared timestamps → losses (MW). */
export function buildLosses(
  inData: TimeseriesData,
  outData: TimeseriesData,
  componentName: string,
): TimeseriesData {
  const outByTs = new Map(
    outData.data.filter((p) => Number.isFinite(p.value)).map((p) => [p.timestamp, p.value]),
  );
  const out = inData.data
    .map((p) => {
      const o = outByTs.get(p.timestamp);
      if (o == null || !Number.isFinite(p.value)) return null;
      return { timestamp: p.timestamp, value: r3(p.value - o) };
    })
    .filter((p): p is { timestamp: string; value: number } => p !== null);
  return {
    ...inData, component_name: componentName, measurement_type: 'P_loss', unit: 'MW', data: out,
  };
}

/** Loading as % of rated apparent power: S / rated · 100. */
export function buildLoading(
  src: DashboardSeries,
  data: TimeseriesData,
  ratedMva: number,
): TimeseriesData {
  const rated = ratedMva > 0 ? ratedMva : 1;
  const out = data.data
    .filter((p) => Number.isFinite(p.value))
    .map((p) => ({ timestamp: p.timestamp, value: r3((p.value / rated) * 100) }));
  return {
    ...data, component_name: src.componentName, measurement_type: 'Auslastung', unit: '%', data: out,
  };
}

/** Sorted-descending duration curve of loading% (share of time ≥ value). */
export function buildOverloadDuration(
  src: DashboardSeries,
  data: TimeseriesData,
  ratedMva: number,
): DurationCurveData {
  const rated = ratedMva > 0 ? ratedMva : 1;
  const values = data.data
    .filter((p) => Number.isFinite(p.value))
    .map((p) => (p.value / rated) * 100)
    .sort((a, b) => b - a);
  const n = values.length;
  const points = values.map((value, i) => ({ percent: r3((i / Math.max(1, n - 1)) * 100), value: r3(value) }));
  return { component_name: src.componentName, measurement_type: 'Auslastung', unit: '%', data: points };
}

/** Centered rolling mean over `window` points (≥1). Non-finite values ignored. */
export function buildRollingMean(
  src: DashboardSeries,
  data: TimeseriesData,
  window: number,
): TimeseriesData {
  const w = Math.max(1, Math.floor(window));
  const vals = data.data;
  const out = vals.map((point, i) => {
    const lo = Math.max(0, i - Math.floor(w / 2));
    const hi = Math.min(vals.length, lo + w);
    let sum = 0;
    let count = 0;
    for (let j = lo; j < hi; j++) {
      if (Number.isFinite(vals[j].value)) { sum += vals[j].value; count += 1; }
    }
    return { timestamp: point.timestamp, value: count ? r3(sum / count) : point.value };
  });
  return {
    ...data,
    component_name: `${src.componentName} · gleitender Mittelwert`,
    measurement_type: data.measurement_type,
    data: out,
  };
}

/** Rolling z-score: (value − rolling mean) / rolling std, in units of σ. */
export function buildAnomalyScore(
  src: DashboardSeries,
  data: TimeseriesData,
  window: number,
): TimeseriesData {
  const w = Math.max(3, Math.floor(window));
  const vals = data.data;
  const out = vals.map((point, i) => {
    const lo = Math.max(0, i - w + 1);
    const slice = vals.slice(lo, i + 1).map((p) => p.value).filter((v) => Number.isFinite(v));
    if (slice.length < 2 || !Number.isFinite(point.value)) {
      return { timestamp: point.timestamp, value: 0 };
    }
    const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length;
    const std = Math.sqrt(variance);
    return { timestamp: point.timestamp, value: std > 1e-9 ? r3((point.value - mean) / std) : 0 };
  });
  return {
    ...data, component_name: `${src.componentName} · Anomalie-Score`, measurement_type: 'z', unit: 'σ', data: out,
  };
}

/**
 * Voltage compliance: the U series plus two flat reference lines at the
 * configured min/max band around nominal voltage (default 90-110 %). Reusing TimeseriesChart's
 * multi-series support gives the band as visible reference lines.
 */
export function buildVoltageBand(
  src: DashboardSeries,
  data: TimeseriesData,
  nominal: number,
  minPct = 90,
  maxPct = 110,
): TimeseriesData[] {
  if (data.data.length === 0) return [data];
  // No explicit nominal → derive it from the data (median of finite samples),
  // so the band is meaningful by default regardless of the unit (kV, p.u., …).
  if (!(nominal > 0)) {
    const finite = data.data.map((p) => p.value).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (finite.length === 0) return [data];
    nominal = finite[Math.floor(finite.length / 2)];
  }
  const saneMinPct = Number.isFinite(minPct) && minPct >= 0 ? minPct : 90;
  const saneMaxPct = Number.isFinite(maxPct) && maxPct >= 0 ? maxPct : 110;
  const lowerPct = Math.min(saneMinPct, saneMaxPct);
  const upperPct = Math.max(saneMinPct, saneMaxPct);
  const upper = nominal * (upperPct / 100);
  const lower = nominal * (lowerPct / 100);
  const flat = (value: number, label: string): TimeseriesData => ({
    ...data,
    component_name: label,
    measurement_type: data.measurement_type,
    data: data.data.map((p) => ({ timestamp: p.timestamp, value: r3(value) })),
  });
  return [
    { ...data, component_name: `${src.componentName} · U` },
    flat(upper, `Obergrenze (${r3(upperPct)}%)`),
    flat(lower, `Untergrenze (${r3(lowerPct)}%)`),
  ];
}
