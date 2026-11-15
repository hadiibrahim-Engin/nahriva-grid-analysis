/** Raw native GridLens data for widgets. No engineering verdicts are inferred here. */
import api from './client';

export interface NativeResult {
  id: string;
  assessment_id: string;
  case_id: string;
  kind: 'QDS' | 'n-1' | "(n-1)'";
  native_name: string;
  native_path: string;
  status: string;
  reason: string;
  metadata: Record<string, unknown>;
  analysis_run_id: string | null;
}

export interface NativeColumn {
  result_id: string;
  column_id: number;
  element_id: string;
  name: string;
  path: string;
  class_name: string;
  variable: string;
  metric: string;
  unit: string;
}

export interface NativeAssessment {
  id: string;
  native_run_id: string;
  project: string;
  study_case: string;
  engine_version: string;
  created_at: string;
  settings: Record<string, unknown>;
  configuration: Record<string, unknown>;
  mode: 'calculated' | 'kept';
}

export interface NativeCase {
  case_id: string;
  name: string;
  status: string;
  reason: string;
  definition: Record<string, unknown>;
}

export interface NativeContingency {
  id: string;
  name: string;
  path: string;
  equipment: string[];
}

export interface NativePoint {
  timestamp: number;
  value: number | null;
  code: number | null;
  state: 'value' | 'not_recorded' | 'missing_row' | 'missing_column' | 'invalid' | 'read_error' | 'invalid_or_missing' | 'missing';
}

/** One overload episode of a branch: consecutive study times beyond the limit, triggered by one contingency. */
export interface N1Episode {
  start: number;
  /** Exclusive: one study time step after the last overloaded one. */
  end: number;
  contingency: string | null;
  /** Highest loading after the contingency, and when. */
  post: number;
  peak_t: number;
  /** Loading before the contingency at that time (QDS of the same case). */
  pre: number | null;
  pre_max: number | null;
  /** (n-1)' only: n-1 loading of the branch without the planned outages at that time. */
  reference: number | null;
  /** Most contingencies beyond the limit at one study time of the episode. */
  violations: number;
}

export interface N1Gantt {
  result_id: string;
  kind: 'n-1' | "(n-1)'";
  case_id: string;
  step: number;
  start: number | null;
  end: number | null;
  /** Case whose QDS gives the loading before the contingency; null when it was not imported. */
  pre_source: string | null;
  has_reference: boolean;
  lines: { name: string; path: string; class_name: string; limit: number | null; peak: number; hours: number; segments: N1Episode[] }[];
  contingencies: Record<string, string>;
}

const root = '/gridlens';
const resultPath = (id: string) => `${root}/results/${encodeURIComponent(id)}`;

export const gridlens = {
  async assessments(signal?: AbortSignal) {
    return (await api.get<{ assessments: NativeAssessment[] }>(`${root}/assessments`, { signal })).data.assessments;
  },
  async assessment(id: string, signal?: AbortSignal) {
    return (await api.get<NativeAssessment & { cases: NativeCase[]; results: NativeResult[] }>(
      `${root}/assessments/${encodeURIComponent(id)}`, { signal })).data;
  },
  async result(id: string, signal?: AbortSignal) {
    return (await api.get<NativeResult>(resultPath(id), { signal })).data;
  },
  async columns(id: string, offset = 0, limit = 200, signal?: AbortSignal) {
    return (await api.get<{ columns: NativeColumn[]; offset: number; limit: number }>(
      `${resultPath(id)}/columns`, { params: { offset, limit }, signal })).data;
  },
  async contingencies(id: string, offset = 0, limit = 100, signal?: AbortSignal) {
    return (await api.get<{ contingencies: NativeContingency[]; offset: number; limit: number }>(
      `${resultPath(id)}/contingencies`, { params: { offset, limit }, signal })).data;
  },
  async times(id: string, offset = 0, limit = 1000, signal?: AbortSignal) {
    return (await api.get<{ timestamps: number[]; unit: 'epoch_seconds_utc'; offset: number; limit: number }>(
      `${resultPath(id)}/times`, { params: { offset, limit }, signal })).data;
  },
  async series(id: string, columnId: number, options: {
    contingencyId?: string; start?: number; end?: number; offset?: number; limit?: number; signal?: AbortSignal;
  } = {}) {
    const { contingencyId, signal, ...range } = options;
    return (await api.get<{ result_id: string; column: NativeColumn; contingency_id: string | null;
      metadata: Record<string, unknown>; points: NativePoint[]; offset: number; limit: number }>(
      `${resultPath(id)}/series`, { params: { column_id: columnId, contingency_id: contingencyId, ...range }, signal })).data;
  },
  /** Overload episodes per branch of an n-1 sweep, for the Gantt chart (from the summaries written at import). */
  async n1Gantt(id: string, limit = 40, signal?: AbortSignal) {
    return (await api.get<N1Gantt>(`${resultPath(id)}/n1-gantt`, { params: { limit }, signal })).data;
  },
};
