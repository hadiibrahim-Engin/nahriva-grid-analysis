/** Load, generation and transit per area (GET /api/simulation/scenarios/{id}/areas). All powers in MW. */
import api from './client';
import type { TimeRange } from '../util/timeRange';

export interface AreaCapability {
  /** Load and generation per area can be evaluated (both recorded). */
  balance: boolean;
  /** Flows between areas and transit can be evaluated (branch power recorded and branches between areas). */
  flows: boolean;
  /** Variables to record in PowerFactory (ComStatsim > Result Variables) for what is not possible. */
  missing: string[];
  notes: string[];
  recorded: { loads: number; sources: number; branches: number };
}

export interface AreaSummary {
  load_mean: number | null;
  load_peak: number | null;
  generation_mean: number | null;
  generation_peak: number | null;
  /** generation - load: positive exports, negative imports. */
  net_mean: number | null;
  net_min: number | null;
  net_max: number | null;
  import_peak: number | null;
  export_peak: number | null;
  /** Power that only passes through: the smaller of import and export. */
  transit_mean: number | null;
  transit_peak: number | null;
  missing_times: number;
}

export interface AreaRow extends AreaSummary {
  area: string;
  ref?: AreaSummary;
}

export interface AreaCourse {
  load: (number | null)[];
  generation: (number | null)[];
  net_min: (number | null)[];
  net_max: (number | null)[];
  import: (number | null)[];
  export: (number | null)[];
  transit: (number | null)[];
}

export interface AreaFlow {
  from: string;
  to: string;
  /** Mean flow, positive from `from` to `to`. */
  mean: number;
  /** The strongest flow with its sign. */
  peak: number;
  /** Share of times the power flows from `from` to `to`. */
  share_forward: number;
}

export interface AreaView {
  scenario_id: string;
  capability: AreaCapability;
  unit: string;
  windows?: [number, number][];
  areas?: AreaRow[];
  times?: number[];
  interval_steps?: number;
  course?: Record<string, AreaCourse>;
  days?: number[];
  daily?: Record<string, { net_mean: (number | null)[]; net_min: (number | null)[]; net_max: (number | null)[]; load_max: (number | null)[] }>;
  flows?: AreaFlow[];
  flows_ref?: AreaFlow[];
}

export async function getAreas(scenarioId: string, range: TimeRange, signal?: AbortSignal): Promise<AreaView> {
  const params = { ...(range.from === null ? {} : { start: range.from }), ...(range.to === null ? {} : { end: range.to }) };
  return (await api.get<AreaView>(`/scenarios/${encodeURIComponent(scenarioId)}/areas`, { params, signal })).data;
}
