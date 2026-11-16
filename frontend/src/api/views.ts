/** The time-point view, the asset explorer and the PowerFactory restore package (read-only API). */
import api from './client';
import type { TimeRange } from '../util/timeRange';

export type ViewMetric = 'loading' | 'voltage';

export interface TimeColumns {
  loading_max: (number | null)[];
  loading_over: (number | null)[];
  voltage_min: (number | null)[];
  voltage_max: (number | null)[];
  voltage_outside: (number | null)[];
}

export interface ScenarioTimes {
  scenario_id: string;
  times: number[];
  windows: [number, number][];
  outage: TimeColumns;
  ref: TimeColumns;
  /** The most critical times of the scenario run, worst first. */
  critical: number[];
  /** 'import': written while importing; 'computed': aggregated from the stored values (earlier imports). */
  source: string | null;
  /** First and last time of the whole course, also when a time range cuts it. */
  period: [number, number] | null;
  /** Times per shown point when the course was reduced (1 = full resolution). */
  interval_steps: number;
}

export interface SnapshotRow {
  element_id: string;
  name: string;
  class_name: string | null;
  type: string;
  grid: string;
  nominal_kv: number | null;
  ref: number | null;
  value: number | null;
  delta: number | null;
  lower: number | null;
  upper: number | null;
  outaged: boolean;
  /** 'value', 'outaged' or 'invalid_or_missing' (GET /api/simulation/states). */
  state: string;
}

export interface Snapshot {
  scenario_id: string;
  t: number;
  metric: ViewMetric;
  in_window: boolean;
  total: number;
  violations: number;
  distribution: { edges: number[]; outage: number[]; ref: number[] };
  rows: SnapshotRow[];
  offset: number;
  limit: number;
}

export interface AssetScenario {
  scenario_id: string;
  name: string;
  kind: 'branch' | 'bus';
  ref_full: number | null;
  cell: Record<string, unknown>;
  /** Component ids of the element in the REF and OUTAGE run, for the time-series endpoints. */
  components: Record<string, string>;
}

export interface AssetN1 {
  case_id: string;
  kind: string;
  metric: string;
  high: number | null;
  high_t: number | null;
  low: number | null;
  upper: number | null;
  lower: number | null;
  violation_times: number;
  contingency_name: string | null;
}

export interface Asset {
  analysis: string;
  element: { element_id: string; name: string; class_name: string | null; path: string | null; grid: string | null; nominal_kv: number | null; mrid: string | null };
  scenarios: AssetScenario[];
  n1: AssetN1[];
}

export interface N1Pair {
  /** The branch that fails. */
  contingency: string;
  element_id: string;
  /** The branch it overloads. */
  element: string;
  grid: string;
  nominal_kv: number | null;
  type: string | null;
  /** Highest loading after the contingency (%), at time `t`. */
  post: number;
  t: number;
  /** Loading before the contingency at `t` (QDS of the planning case for (n-1)', of REF for n-1). */
  pre: number | null;
  limit: number;
  hours_over: number;
}

export interface N1Pairs {
  scenario_id: string;
  kind: "(n-1)'" | 'n-1';
  before: string;
  period: [number, number] | null;
  total_pairs: number;
  contingencies: number;
  elements: number;
  pairs: N1Pair[];
}

export const views = {
  async n1Pairs(scenarioId: string, kind: N1Pairs['kind'], range: TimeRange, limit: number,
    filter: { grid: string | null; kv: number | null; equipment?: 'all' | 'line' | 'transformer'; elementIds?: string[] }, signal?: AbortSignal) {
    const params = {
      kind, limit, ...(range.from === null ? {} : { start: range.from }), ...(range.to === null ? {} : { end: range.to }),
      ...(filter.grid === null ? {} : { grid: filter.grid }), ...(filter.kv === null ? {} : { kv: filter.kv }),
      ...(filter.equipment && filter.equipment !== 'all' ? { equipment: filter.equipment } : {}),
      ...(filter.elementIds?.length ? { element_ids: filter.elementIds.join(',') } : {}),
    };
    return (await api.get<N1Pairs>(`/scenarios/${encodeURIComponent(scenarioId)}/n1-pairs`, { params, signal })).data;
  },
  async times(scenarioId: string, range: TimeRange, signal?: AbortSignal) {
    const params = { ...(range.from === null ? {} : { start: range.from }), ...(range.to === null ? {} : { end: range.to }) };
    return (await api.get<ScenarioTimes>(`/scenarios/${encodeURIComponent(scenarioId)}/times`, { params, signal })).data;
  },
  async snapshot(scenarioId: string, t: number, metric: ViewMetric, page: { limit: number; offset: number },
    filter: { grid: string | null; kv: number | null }, signal?: AbortSignal) {
    const params = { t, metric, ...page, ...(filter.grid === null ? {} : { grid: filter.grid }), ...(filter.kv === null ? {} : { kv: filter.kv }) };
    return (await api.get<Snapshot>(`/scenarios/${encodeURIComponent(scenarioId)}/snapshot`, { params, signal })).data;
  },
  async restorePackage(scenarioId: string, t: number | null, signal?: AbortSignal) {
    return (await api.get<Record<string, unknown>>(`/scenarios/${encodeURIComponent(scenarioId)}/restore-package`,
      { params: t === null ? {} : { t }, signal })).data;
  },
  async asset(elementId: string, analysis: string | null, signal?: AbortSignal) {
    return (await api.get<Asset>(`/assets/${encodeURIComponent(elementId)}`,
      { params: analysis === null ? {} : { analysis }, signal })).data;
  },
};

export const utc = (t: number) => new Date(t * 1000).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'short' });
