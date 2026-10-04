import axios from 'axios';
import { logInfo, logError } from '../debug/debugLog';
import { withCache, paramsKey, type CacheOptions } from './cache';

export { clearCache } from './cache';

const api = axios.create({
  baseURL: '/api/simulation',
  headers: { Accept: 'application/json' },
  // Bounded, so a spinner cannot run forever when the backend hangs.
  timeout: 120_000,
});

// Cast helper for stashing the request start time on the axios config. The
// extra _startTime property isn't part of the declared interface, so we tunnel
// through `unknown` instead of relying on a structural cast.
type Timed = { _startTime?: number };
const timed = (config: unknown): Timed => config as unknown as Timed;

api.interceptors.request.use((config) => {
  timed(config)._startTime = Date.now();
  return config;
});

api.interceptors.response.use(
  (response) => {
    const duration = Date.now() - (timed(response.config)._startTime ?? Date.now());
    const url = `${response.config.method?.toUpperCase()} ${response.config.url}`;
    const body: unknown = response.data;
    let dataLength: number | undefined;
    if (Array.isArray(body)) {
      dataLength = body.length;
    } else if (body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)) {
      dataLength = ((body as { data: unknown[] }).data).length;
    }
    logInfo('API', `${url} → ${response.status} (${duration}ms)`, {
      params: response.config.params,
      dataKeys: body && typeof body === 'object' ? Object.keys(body) : [],
      dataLength,
    });
    return response;
  },
  (error) => {
    const config = error.config;
    const url = config ? `${config.method?.toUpperCase()} ${config.url}` : 'unknown';
    const duration = config ? Date.now() - (timed(config)._startTime ?? Date.now()) : 0;
    const status = error.response?.status;
    const serverMessage = error.response?.data?.detail || error.response?.data?.message || error.response?.statusText || '';

    if (status) {
      logError('API', `${url} → ${status} (${duration}ms)`, serverMessage, {
        params: config?.params,
        responseData: error.response?.data,
      });
    } else if (error.code === 'ERR_NETWORK' || error.message === 'Network Error') {
      logError('API', `${url} → Network Error (${duration}ms)`, 'Backend not reachable. Is the server running?');
    } else if (error.code === 'ECONNABORTED') {
      logError('API', `${url} → Timeout (${duration}ms)`, 'The request took too long');
    } else {
      logError('API', `${url} → ${error.message}`, error.stack);
    }
    return Promise.reject(error);
  }
);

export default api;

// --- Facilities (saved scenarios) ---
export interface Facility {
  id: string;
  name: string;
  project?: string | null;
}

export async function getFacilities(opts?: CacheOptions): Promise<Facility[]> {
  return withCache(
    'facilities',
    async () => {
      const res = await api.get<Facility[]>('/facilities');
      if (!Array.isArray(res.data)) {
        throw new Error('The server returned an unexpected scenario list (check the proxy / base URL).');
      }
      return res.data;
    },
    { ttlMs: 30 * 60_000, persist: true, ...opts },
  );
}

// --- Components ---
export interface GridComponent {
  id: string;
  facility_id: string;
  name: string;
  class_name?: string | null;
  /** PowerFactory grid (ElmNet) of the element, '' when it has none. */
  grid?: string | null;
}

export async function getComponentsByFacility(facilityId: string, opts?: CacheOptions): Promise<GridComponent[]> {
  return withCache(
    `components2|${facilityId}`, // 2: with the grid of each element
    async () => {
      const res = await api.get(`/facilities/${facilityId}/components`);
      return res.data;
    },
    { ttlMs: 30 * 60_000, persist: true, ...opts },
  );
}

export interface MeasurementTypeInfo {
  type: string;
  unit: string;
}

export async function getMeasurementTypes(componentId: string, opts?: CacheOptions): Promise<MeasurementTypeInfo[]> {
  return withCache(
    // Key MUST include the component id — otherwise the first component's
    // measurement types would be cached and returned for every other
    // component (they were, for the 60-min persisted TTL).
    `measurement-types|${componentId}`,
    async () => {
      const res = await api.get(`/components/${componentId}/measurement-types`);
      return res.data;
    },
    { ttlMs: 60 * 60_000, persist: true, ...opts },
  );
}

// --- Timeseries ---
export interface TimeseriesPoint {
  timestamp: string;
  value: number;
}

// Self-describing provenance returned by the backend on every measurement
// response. The dashboard uses this to state plainly whether it is showing
// raw (native-resolution) data or user-requested aggregation.
export interface MeasurementMeta {
  is_raw: boolean;
  downsampled: boolean;
  aggregation_method: AggregationFn | null;
  bucket_seconds: number | null;
  native_resolution_seconds: number;
  point_count: number;
  source: 'simulation';
  start: string | null;
  end: string | null;
  request_id: string | null;
}

export interface TimeseriesData {
  component_id: string;
  component_name: string;
  measurement_type: string;
  unit: string;
  data: TimeseriesPoint[];
  meta?: MeasurementMeta;
  // Set on raw responses when more pages follow (keyset cursor).
  next_cursor?: string | null;
  // Flattened convenience mirrors of `meta`, kept for back-compat with
  // existing chart/badge code. Derived by `flattenMeta`.
  total_raw_count?: number;
  downsampled?: boolean;
  bucket_seconds?: number | null;
}

/** Thrown when a raw request would exceed the backend's point cap. */
export class RawRangeTooLargeError extends Error {
  estimatedPoints?: number;
  maxPoints?: number;
  suggestedAction?: string;
  constructor(
    message: string,
    details?: { estimated_points?: number; max_points?: number },
    suggestedAction?: string,
  ) {
    super(message);
    this.name = 'RawRangeTooLargeError';
    this.estimatedPoints = details?.estimated_points;
    this.maxPoints = details?.max_points;
    this.suggestedAction = suggestedAction;
  }
}

/** Mirror `meta` onto the legacy flat fields so older consumers keep working. */
function flattenMeta(d: TimeseriesData): TimeseriesData {
  if (d.meta) {
    d.downsampled = d.meta.downsampled;
    d.bucket_seconds = d.meta.bucket_seconds;
    d.total_raw_count = d.meta.point_count;
  }
  return d;
}

export type AggregationFn = 'AVG' | 'MIN' | 'MAX' | 'SUM';

/**
 * Raw, native-resolution measurements. Never aggregates or downsamples.
 * Oversized ranges throw `RawRangeTooLargeError` (422 RAW_RANGE_TOO_LARGE)
 * instead of being silently thinned out.
 */
// Upper bound on keyset pages followed per window. The backend refuses
// ranges estimated above RAW_RANGE_MAX_POINTS (≈200k) up front, so at the
// 50k page cap a valid window never needs more than a handful of pages;
// this guard only protects against an unexpectedly non-terminating cursor.
const RAW_MAX_PAGES = 64;

export async function getRawTimeseries(
  componentId: string,
  measurementType: string,
  start: string | undefined,
  end: string | undefined,
  opts?: { limit?: number; cursor?: string; signal?: AbortSignal },
): Promise<TimeseriesData> {
  const fetchPage = async (cursor?: string): Promise<TimeseriesData> => {
    const params: Record<string, string | number | undefined> = { start, end };
    if (opts?.limit !== undefined) params.limit = opts.limit;
    if (cursor) params.cursor = cursor;
    const res = await api.get(`/timeseries/raw/${componentId}/${measurementType}`, {
      params,
      signal: opts?.signal,
    });
    return flattenMeta(res.data);
  };

  try {
    // Explicit-cursor mode: caller drives pagination one page at a time.
    if (opts?.cursor) return await fetchPage(opts.cursor);

    // Auto mode: follow keyset cursors so a window spanning several pages is
    // returned whole instead of silently truncated to the first page.
    const merged = await fetchPage();
    let cursor = merged.next_cursor;
    let pages = 0;
    while (cursor && pages < RAW_MAX_PAGES) {
      const next = await fetchPage(cursor);
      merged.data = merged.data.concat(next.data);
      cursor = next.next_cursor;
      pages += 1;
    }
    merged.next_cursor = null;
    merged.total_raw_count = merged.data.length;
    if (merged.meta) merged.meta.point_count = merged.data.length;
    return merged;
  } catch (err) {
    const e = err as {
      response?: { status?: number; data?: { error_code?: string; message?: string; details?: { estimated_points?: number; max_points?: number }; suggested_action?: string } };
    };
    if (e.response?.status === 422 && e.response.data?.error_code === 'RAW_RANGE_TOO_LARGE') {
      throw new RawRangeTooLargeError(
        e.response.data.message || 'Time range too large',
        e.response.data.details,
        e.response.data.suggested_action,
      );
    }
    // An empty window is a valid result (no measurements in range), not an
    // error: return an empty series so the chart renders blank instead of an
    // error card. Mirrors the mock backend, which returns 200 with data:[].
    if (e.response?.status === 404 && e.response.data?.error_code === 'NO_DATA') {
      return emptyTimeseries(componentId, measurementType, start, end, true);
    }
    throw err;
  }
}

/** A valid, empty result for a window that contains no measurements. */
function emptyTimeseries(
  componentId: string,
  measurementType: string,
  start: string | undefined,
  end: string | undefined,
  isRaw: boolean,
): TimeseriesData {
  return {
    component_id: componentId,
    component_name: componentId,
    measurement_type: measurementType,
    unit: '',
    data: [],
    next_cursor: null,
    total_raw_count: 0,
    downsampled: false,
    bucket_seconds: null,
    meta: {
      is_raw: isRaw,
      downsampled: false,
      aggregation_method: null,
      bucket_seconds: null,
      native_resolution_seconds: 0,
      point_count: 0,
      source: 'simulation',
      start: start ?? '',
      end: end ?? '',
      request_id: null,
    },
  };
}

/** Explicitly user-requested aggregation over a fixed bucket (seconds). */
export async function getAggregatedTimeseries(
  componentId: string,
  measurementType: string,
  start: string | undefined,
  end: string | undefined,
  bucketSeconds: number,
  method: AggregationFn = 'AVG',
  signal?: AbortSignal,
): Promise<TimeseriesData> {
  const params: Record<string, string | number | undefined> = {
    start,
    end,
    bucket: bucketSeconds,
    aggregation_method: method,
  };
  try {
    const res = await api.get(`/timeseries/aggregate/${componentId}/${measurementType}`, {
      params,
      signal,
    });
    return flattenMeta(res.data);
  } catch (err) {
    const e = err as { response?: { status?: number; data?: { error_code?: string } } };
    // Empty window is a valid result, not an error (see getRawTimeseries).
    if (e.response?.status === 404 && e.response.data?.error_code === 'NO_DATA') {
      return emptyTimeseries(componentId, measurementType, start, end, false);
    }
    throw err;
  }
}

/**
 * Back-compat facade. Routes to the raw endpoint by default, or to the
 * aggregate endpoint when an explicit downsample interval is given.
 * Raw is never silently aggregated.
 */
export async function getTimeseries(
  componentId: string,
  measurementType: string,
  start?: string,
  end?: string,
  downsampleMinutes?: number,
  maxPoints?: number,
  signal?: AbortSignal,
  agg?: AggregationFn,
): Promise<TimeseriesData> {
  if (downsampleMinutes && downsampleMinutes > 0) {
    return getAggregatedTimeseries(
      componentId, measurementType, start, end, downsampleMinutes * 60, agg ?? 'AVG', signal,
    );
  }
  return getRawTimeseries(componentId, measurementType, start, end, { limit: maxPoints, signal });
}

export interface ResolutionInfo {
  // Aggregation interval in minutes (0 = raw / native resolution).
  minutes: number;
  label: string;
}

export async function getResolutions(): Promise<ResolutionInfo[]> {
  return withCache(
    'resolutions',
    async () => {
      // Backend returns aggregation buckets as { seconds, label }; the
      // frontend works in minutes, so map here.
      const res = await api.get('/timeseries/aggregate/resolutions');
      const rows = Array.isArray(res.data) ? res.data : [];
      return rows.map((r: { seconds: number; label: string }) => ({
        minutes: Math.round((r.seconds ?? 0) / 60),
        label: r.label,
      }));
    },
    { ttlMs: 60 * 60_000 },
  );
}

// --- Analytics ---
// Saved simulation results do not change while a dashboard is open; a 30-minute TTL lets repeated
// visits or page refreshes (via sessionStorage) feel instant.
const ANALYTICS_TTL_MS = 30 * 60_000;

export interface DurationCurvePoint {
  percent: number;
  value: number;
}

export interface DurationCurveData {
  component_name: string;
  measurement_type: string;
  unit: string;
  data: DurationCurvePoint[];
}

export async function getDurationCurve(
  componentId: string,
  measurementType: string,
  start?: string,
  end?: string,
  opts?: CacheOptions,
): Promise<DurationCurveData> {
  const params: Record<string, string | undefined> = { start, end };
  return withCache(
    `duration-curve|${componentId}|${measurementType}|${paramsKey(params as Record<string, unknown>)}`,
    async () => {
      const res = await api.get(`/analytics/${componentId}/${measurementType}/duration-curve`, { params });
      return res.data;
    },
    { ttlMs: ANALYTICS_TTL_MS, ...opts },
  );
}

// --- Correlation ---
export interface CorrelationPoint {
  x: number;
  y: number;
}

/** Which statistic the scatter's r-value was computed with. Pearson (linear,
 * O(n)) is the default; Spearman/Kendall are rank-based and catch monotonic
 * (not just linear) relationships at higher compute cost. */
export type CorrelationMethod = 'pearson' | 'spearman' | 'kendall';

export interface CorrelationScatterData {
  component_name: string;
  type_x: string;
  unit_x: string;
  type_y: string;
  unit_y: string;
  correlation: number;
  /** Which method computed `correlation`. Absent = Pearson (backend-computed
   * correlation-matrix responses predate this field). */
  method?: CorrelationMethod;
  /** Minutes Y was shifted relative to X for this computation. */
  lag_minutes: number;
  /** Short hint surfaced beside the scatter plot. */
  interpretation: string;
  data: CorrelationPoint[];
}

// --- Correlation Matrix ---
export interface CorrelationMatrixData {
  component_name: string;
  types: string[];
  units: string[];
  // Cells may be null when no correlation is available for that pair.
  matrix: (number | null)[][];
}

export async function getCorrelationMatrix(
  componentId: string,
  types: string[],
  start?: string,
  end?: string,
  opts?: CacheOptions,
): Promise<CorrelationMatrixData> {
  const params: Record<string, string | undefined> = { types: types.join(','), start, end };
  return withCache(
    `correlation-matrix|${componentId}|${paramsKey(params as Record<string, unknown>)}`,
    async () => {
      const res = await api.get(`/analytics/${componentId}/correlation-matrix`, { params });
      return res.data;
    },
    { ttlMs: ANALYTICS_TTL_MS, ...opts },
  );
}

// --- Box Plot ---
export interface BoxPlotItem {
  label: string;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
}

export type BoxPlotGroupBy = 'hour' | 'weekday' | 'month' | 'weekday_weekend';

export interface BoxPlotData {
  component_name: string;
  measurement_type: string;
  unit: string;
  group_by: BoxPlotGroupBy;
  items: BoxPlotItem[];
}

export async function getBoxPlot(
  componentId: string,
  measurementType: string,
  start?: string,
  end?: string,
  groupBy: BoxPlotGroupBy = 'hour',
  opts?: CacheOptions,
): Promise<BoxPlotData> {
  const params: Record<string, string | undefined> = { start, end, group_by: groupBy };
  return withCache(
    `boxplot|${componentId}|${measurementType}|${paramsKey(params as Record<string, unknown>)}`,
    async () => {
      const res = await api.get(`/analytics/${componentId}/${measurementType}/boxplot`, { params });
      return res.data;
    },
    { ttlMs: ANALYTICS_TTL_MS, ...opts },
  );
}

// --- Exceedance Analysis ---
export interface ExceedanceDay {
  day: string;
  minutes_above: number;
  max_value: number;
  mean_value: number;
}

export interface ExceedanceData {
  component_name: string;
  measurement_type: string;
  unit: string;
  threshold: number;
  total_minutes_above: number;
  total_pct: number;
  top_days: ExceedanceDay[];
}

export async function getExceedance(
  componentId: string,
  measurementType: string,
  threshold: number,
  start?: string,
  end?: string,
  opts?: CacheOptions,
): Promise<ExceedanceData> {
  const params: Record<string, string | number | undefined> = { threshold };
  if (start) params.start = start;
  if (end) params.end = end;
  return withCache(
    `exceedance|${componentId}|${measurementType}|${paramsKey(params)}`,
    async () => {
      const res = await api.get(`/analytics/${componentId}/${measurementType}/exceedance`, { params });
      return res.data;
    },
    { ttlMs: ANALYTICS_TTL_MS, ...opts },
  );
}
