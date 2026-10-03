// Reload-safe dashboard view: saved to localStorage (no length limit), so a refresh, or recovery
// after a dropped connection, restores the selection, the added charts and the open panels.

import type { DashboardChartConfig } from './dynamicCharts';

const LOCAL_KEY = 'powerfactoryDashboardView';

export interface SavedSeries {
  key: string;
  facilityName: string;
  facilityId: string;
  componentId: string;
  componentName: string;
  measurementType: string;
}

export interface SavedView {
  v: 1;
  fac: string | null;
  cmp: string | null;
  mt: string;
  series: SavedSeries[];
  charts: DashboardChartConfig[];
  /** IDs of the optional views the user has added — 'timeseries', 'heatmap',
   * 'peakDemand'. Absent or empty means only the summary is shown. */
  panels?: string[];
}

export function saveLocalView(view: SavedView): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(view));
  } catch {
    /* quota / privacy mode — non-fatal */
  }
}

export function loadLocalView(): SavedView | null {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.v !== 1 || !Array.isArray(obj.series) || !Array.isArray(obj.charts)) return null;
    return obj as SavedView;
  } catch {
    return null;
  }
}

export function clearLocalView(): void {
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* ignore */
  }
}
