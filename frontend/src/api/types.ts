export interface ElementIdentity {
  id: string;
  name: string;
  className: string | null;
  type: string;
  path: string | null;
}
export interface Run {
  id: string;
  name: string;
  project: string;
  study_case: string;
  source: string;
  status: string;
  start: string | null;
  end: string | null;
  sample_count: number;
}
export interface Metric {
  id: string;
  name: string;
  unit: string;
  lower: number | null;
  upper: number | null;
}
export interface Statistics {
  count: number;
  missing: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  std_dev: number | null;
  p95: number | null;
  violations: number;
}
export interface ElementResult extends ElementIdentity, Statistics {}
export interface Point {
  timestamp: string;
  mean: number | null;
  min?: number;
  max?: number;
  count?: number;
}
export interface Analysis {
  run: Run;
  metric: Metric;
  stats: Statistics;
  points: Point[];
  elements: ElementResult[];
  histogram: { lower: number; upper: number; count: number }[];
  duration: { percent: number; value: number }[];
  comparison: {
    run: Run;
    matched_count: number;
    mean_delta: number | null;
    points: Point[];
  } | null;
  meta: {
    source: string;
    sample_count: number;
    element_count: number;
    timezone: string;
    start: string | null;
    end: string | null;
  };
}
export interface Capabilities {
  mode: string;
  auth_required: boolean;
  oracle_configured: boolean;
  powerfactory_bridge: boolean;
  schema_version: number;
}
