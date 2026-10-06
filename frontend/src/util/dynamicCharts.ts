/**
 * Shared types + pure helpers for the dynamic ("Add chart") workflow.
 *
 * These are framework-free so both the dashboard page and DynamicChartCard can
 * reuse them without pulling in chart runtimes. The peak-demand and correlation
 * builders mirror the logic already used by the fixed dashboard panels so a
 * generated card produces identical numbers.
 */
import type { CorrelationMethod, CorrelationScatterData, TimeseriesData } from '../api/client';

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
  /** 'selected': show exactly the chosen items (elementIds) instead of the automatic top N. */
  elementMode?: 'auto' | 'selected';
  /** Chosen branch or busbar ids (element ids of the saved results). */
  elementIds?: string[];
  /** Chosen scenario ids; empty or absent = all scenarios. */
  scenarioIds?: string[];
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
  if (index === 0) return 'Warning';
  if (index === total - 1) return 'Exceedance';
  return `Level ${index + 1}`;
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
  L: 'Loading',
  LOSS: 'Losses',
  P: 'Active power (P)',
  Q: 'Reactive power (Q)',
  S: 'Apparent power (S)',
  U: 'Voltage (U)',
  I: 'Current (I)',
  m_P_busmv: 'Active power, MV side (P)',
  m_Q_busmv: 'Reactive power, MV side (Q)',
  m_I_busmv: 'Current, MV side (I)',
  m_P_buslv: 'Active power, LV side (P)',
  m_Q_buslv: 'Reactive power, LV side (Q)',
  m_I_buslv: 'Current, LV side (I)',
  m_phiu: 'Voltage angle',
  m_Ul: 'Voltage (line-line)',
};

export function seriesLabel(series: DashboardSeries): string {
  const measurement = MTYPE_LABELS[series.measurementType] ?? series.measurementType;
  return `${series.facilityName} / ${series.componentName} - ${measurement}`;
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
  spearman: 'Spearman (rank, monotonic)',
  kendall: 'Kendall (rank, robust)',
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
    throw new Error('Too few common time points for this correlation. Check the time range or the resolution.');
  }

  const correlation = correlationBy(method, points);
  const direction = Math.abs(correlation) > 0.7
    ? 'strong'
    : Math.abs(correlation) > 0.4
      ? 'moderate'
      : 'weak';

  return {
    component_name: `${xSeries.componentName} ↔ ${ySeries.componentName}`,
    type_x: xSeries.measurementType,
    unit_x: xData.unit,
    type_y: ySeries.measurementType,
    unit_y: yData.unit,
    correlation,
    method,
    lag_minutes: 0,
    interpretation: `${direction} ${CORRELATION_METHOD_LABELS[method]} correlation from ${points.length.toLocaleString()} common time points.`,
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
    throw new Error('Too few common time points for this correlation. Check the time range or the resolution.');
  }

  const correlation = correlationBy(method, points);
  const direction = Math.abs(correlation) > 0.7
    ? 'strong'
    : Math.abs(correlation) > 0.4
      ? 'moderate'
      : 'weak';

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
    interpretation: `${direction} ${CORRELATION_METHOD_LABELS[method]} correlation (X/Y) from ${points.length.toLocaleString()} common time points, coloured by ${zSeries.measurementType}.`,
    data: points,
  };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

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
    component_name: `${src.componentName} · rolling mean`,
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
    ...data, component_name: `${src.componentName} · anomaly score`, measurement_type: 'z', unit: 'σ', data: out,
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
    flat(upper, `Upper limit (${r3(upperPct)}%)`),
    flat(lower, `Lower limit (${r3(lowerPct)}%)`),
  ];
}
