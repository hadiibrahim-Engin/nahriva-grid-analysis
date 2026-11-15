/** Analysis A against B and scenario A against B (read-only API, GET /api/simulation/compare/…). */
import api from './client';
import type { AnalysisInfo } from '../hooks/useAnalysis';

export interface CompareCheck {
  check: string;
  /** ok, warning (results only partly comparable) or info (a difference that is part of the question). */
  status: 'ok' | 'warning' | 'info';
  detail: string;
}

export interface ScenarioPeak {
  id: string;
  name: string;
  status: string;
  equipment: string[];
  windows: [number, number][];
  loading_max: number | null;
  overloaded_max: number | null;
  /** Number of times with at least one branch above its limit. */
  overloaded_times: number | null;
  voltage_min: number | null;
  voltage_max: number | null;
  voltage_outside_max: number | null;
  times: number;
}

export interface ScenarioPair {
  equipment: string[];
  a: ScenarioPeak | null;
  b: ScenarioPeak | null;
  windows_equal: boolean;
  delta_loading_max: number | null;
  delta_voltage_min: number | null;
  delta_overloaded_times: number | null;
}

export interface AnalysisComparison {
  a: AnalysisInfo;
  b: AnalysisInfo;
  checks: CompareCheck[];
  settings: { setting: string; a: unknown; b: unknown }[];
  pairs: ScenarioPair[];
}

export interface ElementDelta {
  element_id: string;
  name: string;
  type: string;
  grid: string;
  nominal_kv: number | null;
  /** Loading: the highest value in the outage window; voltage: [lowest, highest]. */
  a: number | null | [number | null, number | null];
  b: number | null | [number | null, number | null];
  delta: number | null;
  /** value, outaged, only_a or only_b. */
  state: string;
}

export interface ScenarioComparison {
  a: ScenarioPeak;
  b: ScenarioPeak;
  metric: 'loading' | 'voltage';
  checks: CompareCheck[];
  tolerance: number;
  counts: { total: number; both: number; only_a: number; only_b: number; higher: number; lower: number };
  filtered: number;
  offset: number;
  limit: number;
  rows: ElementDelta[];
}

export const compare = {
  async analyses(a: string, b: string, signal?: AbortSignal) {
    return (await api.get<AnalysisComparison>('/compare/analyses', { params: { a, b }, signal })).data;
  },
  async scenarios(a: string, b: string, metric: 'loading' | 'voltage', page: { limit: number; offset: number; q: string },
    signal?: AbortSignal) {
    const params = { a, b, metric, limit: page.limit, offset: page.offset, ...(page.q ? { q: page.q } : {}) };
    return (await api.get<ScenarioComparison>('/compare/scenarios', { params, signal })).data;
  },
};
