import api from './client';

export type NetworkMetric = 'loading' | 'voltage' | 'active_power' | 'redispatch';
export interface HeatCell { t: number; value: number }
export interface NetworkTimeline {
  analysis: string; times: number[]; columns: { start: number; end: number }[];
  scenarios: { id: string; name: string; has_qds: boolean; cells: (HeatCell | null)[] }[];
  metric: NetworkMetric; interval_steps: number; element: string | null; delivery: Delivery | null;
}
export interface Delivery { id: string; source: string; quantity_kind: string; created_at: string; rows: number }
export interface PlantHour {
  element_id: string; name: string; class_name: string; grid: string; nominal_kv: number | null;
  scenario_id: string; scenario_name: string; active_power_mw: number | null;
  energy_mwh: number | null; price_eur_per_mwh: number | null; cost_eur: number | null;
}
export interface NetworkHour {
  analysis: string; t: number; hour_start: number; delivery: Delivery | null;
  scenarios: { id: string; name: string; has_time: boolean; loading_max: number | null; loading_over: number | null;
    value: number | null; ref: number | null; metric: string | null; outaged: boolean;
    redispatch: { energy_mwh: number; cost_eur: number; hours: number } | null; redispatch_expected_plants: number }[];
  plants: PlantHour[];
  element: { element_id: string; name: string; class_name: string; grid: string; nominal_kv: number | null } | null;
}
export const networkApi = {
  async timeline(params: { analysis: string | null; element?: string; metric: NetworkMetric; start?: number; end?: number }, signal: AbortSignal) {
    return (await api.get<NetworkTimeline>('/network/timeline', { params, signal })).data;
  },
  async hour(params: { analysis: string | null; t: number; element?: string; grid: string | null; kv: number | null }, signal: AbortSignal) {
    return (await api.get<NetworkHour>('/network/at-time', { params, signal })).data;
  },
};
