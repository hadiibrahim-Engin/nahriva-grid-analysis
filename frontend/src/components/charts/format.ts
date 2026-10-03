const CHART_NUMBER_FORMATTER = new Intl.NumberFormat('de-DE', {
  maximumFractionDigits: 3,
});

export function formatChartNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return CHART_NUMBER_FORMATTER.format(value);
}

export function formatChartPercent(value: number | null | undefined): string {
  return `${formatChartNumber(value)}%`;
}

export function formatChartValue(value: unknown): string {
  if (typeof value === 'number') return formatChartNumber(value);
  if (Array.isArray(value)) {
    const numeric = [...value].reverse().find((item) => typeof item === 'number');
    return typeof numeric === 'number' ? formatChartNumber(numeric) : String(value);
  }
  return String(value ?? '-');
}

export function yAxisNameStyle(color: string, gap = 62) {
  return {
    nameLocation: 'middle' as const,
    nameGap: gap,
    nameRotate: 90,
    nameTextStyle: { color, align: 'center' as const },
  };
}

export const Y_AXIS_GRID_LEFT = 92;
export const DATA_ZOOM_SLIDER_HEIGHT = 12;
export const DATA_ZOOM_SLIDER_WIDTH = 10;
export const DATA_ZOOM_BOTTOM = 10;
export const DATA_ZOOM_RIGHT = 8;
export const DATA_ZOOM_Y_GRID_RIGHT = 56;

export interface YAxisScaleProps {
  yAxisScaleType?: 'auto' | 'manual';
  yAxisMin?: number;
  yAxisMax?: number;
  yAxisLog?: boolean;
}

export function scaledValueAxis(
  scale?: YAxisScaleProps,
  fallback?: { min?: unknown; max?: unknown },
  opts?: {
    /** Fit the axis tightly around the actual data range in auto mode
     * instead of ECharts' default of always extending the range to include
     * zero. Only safe for line/scatter/boxplot-style charts — bar series
     * need the zero baseline to stay visually honest, so callers with bar
     * series must leave this off. */
    scaleToData?: boolean;
  },
) {
  const manual = scale?.yAxisScaleType === 'manual';
  const axis: {
    type: 'value' | 'log';
    min?: unknown;
    max?: unknown;
    scale?: boolean;
  } = {
    type: manual && scale?.yAxisLog ? 'log' : 'value',
  };

  if (manual && scale?.yAxisMin != null) axis.min = scale.yAxisMin;
  else if (fallback && 'min' in fallback) axis.min = fallback.min;

  if (manual && scale?.yAxisMax != null) axis.max = scale.yAxisMax;
  else if (fallback && 'max' in fallback) axis.max = fallback.max;

  if (!manual && opts?.scaleToData) axis.scale = true;

  return axis;
}

/** Sanitize a fragment for use inside a download filename (no spaces, slashes,
 * umlauts kept but stripped of path/quote characters). */
function sanitizeNamePart(part: string): string {
  return part
    .trim()
    .replace(/[\s/\\]+/g, '-')
    .replace(/[<>:"|?*]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Build a self-describing chart-image filename from a base label, the signal
 * names shown, and the covered date range — so a downloaded PNG says what it
 * is without opening it. Falls back gracefully when parts are missing.
 *
 * Example: "Zeitreihen-Overlay_Trafo-1-P_Trafo-1-Q_2026-06-01_2026-07-01"
 */
export function buildChartExportName(opts: {
  base: string;
  signals?: string[];
  startDate?: string | null;
  endDate?: string | null;
}): string {
  const parts: string[] = [sanitizeNamePart(opts.base)];

  // Cap at 3 signal fragments so the filename stays reasonable.
  const signals = (opts.signals ?? [])
    .map(sanitizeNamePart)
    .filter(Boolean)
    .slice(0, 3);
  parts.push(...signals);

  const start = opts.startDate?.slice(0, 10);
  const end = opts.endDate?.slice(0, 10);
  if (start && end && start !== end) parts.push(start, end);
  else if (start) parts.push(start);

  return parts.filter(Boolean).join('_') || 'chart';
}
