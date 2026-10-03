/**
 * DynamicChartCard — renders a single user-generated chart.
 *
 * It resolves its configured source signals against the live dashboard
 * selection, fetches (or derives) the data its template needs, shows the
 * canonical "Generating" loader while that happens, and renders the matching
 * lazy ECharts component inside an ErrorBoundary + Suspense (so lazy loading and
 * error isolation behave exactly like the fixed dashboard panels).
 *
 * Distribution templates (histogram, boxplot, duration curve) accept multiple
 * signals and render as small multiples — one chart per selected signal.
 *
 * If a configured source signal has been removed from the dashboard, the card
 * degrades to a "source missing" state instead of crashing.
 */
import { SectionCard } from './across/shared';
import { useEffect, useMemo, useState, lazy, Suspense, type ReactNode } from 'react';
import {
  getTimeseries,
  getHeatmap,
  getDurationCurve,
  getDailyProfile,
  getCorrelationMatrix,
  getBoxPlot,
  getPowerFactor,
  getExceedance,
  getQuality,
  getDSTEvents,
  getSeasonRadar,
  type TimeseriesData,
  type AggregationFn,
  type ResolutionInfo,
  type HeatmapData,
  type DurationCurveData,
  type DailyProfileData,
  type CorrelationMatrixData,
  type BoxPlotData,
  type PowerFactorData,
  type ExceedanceData,
  type QualityData,
  type DSTData,
  type SeasonRadarData,
} from '../api/client';
import ErrorBoundary from './ErrorBoundary';
import GeneratingLoader from './ui/GeneratingLoader';
import ColorSwatchPicker from './ui/ColorSwatchPicker';
import {
  buildCorrelation,
  buildCorrelation3,
  buildPeakRows,
  buildEnergyIntegral,
  buildLosses,
  buildLoading,
  buildOverloadDuration,
  buildRollingMean,
  buildAnomalyScore,
  buildVoltageBand,
  missingRequiredMeasurements,
  seriesLabel,
  defaultThresholdLevelName,
  defaultThresholdLevelColor,
  normalizeThresholdLevelColor,
  normalizeThresholdLevelEntries,
  MTYPE_LABELS,
  type DashboardChartConfig,
  type DynamicChartConfig,
  type DashboardSeries,
} from '../util/dynamicCharts';
import { getTemplate, ARITY_LABELS, type ChartTemplate } from './charts/chartTemplates';
import type { PeakDemandPeriod } from './charts/PeakDemandChart';

const TimeseriesChart = lazy(() => import('./charts/TimeseriesChart'));
const TimeseriesHistogramChart = lazy(() => import('./charts/TimeseriesHistogramChart'));
const HistogramCombinedChart = lazy(() => import('./charts/HistogramCombinedChart'));
const HeatmapChart = lazy(() => import('./charts/HeatmapChart'));
const DurationCurveChart = lazy(() => import('./charts/DurationCurveChart'));
const DailyProfileChart = lazy(() => import('./charts/DailyProfileChart'));
const CorrelationChart = lazy(() => import('./charts/CorrelationChart'));
const Correlation3DChart = lazy(() => import('./charts/Correlation3DChart'));
const CorrelationMatrixChart = lazy(() => import('./charts/CorrelationMatrixChart'));
const BoxPlotChart = lazy(() => import('./charts/BoxPlotChart'));
const BoxPlotCombinedChart = lazy(() => import('./charts/BoxPlotCombinedChart'));
const PowerFactorChart = lazy(() => import('./charts/PowerFactorChart'));
const ExceedanceChart = lazy(() => import('./charts/ExceedanceChart'));
const QualityChart = lazy(() => import('./charts/QualityChart'));
const DSTChart = lazy(() => import('./charts/DSTChart'));
const SeasonRadarChart = lazy(() => import('./charts/SeasonRadarChart'));
const PeakDemandChart = lazy(() => import('./charts/PeakDemandChart'));

const PEAK_PERIOD_LABELS: Record<PeakDemandPeriod, string> = {
  day: 'Täglich',
  week: 'Wöchentlich',
  month: 'Monatlich',
};

const AGG_LABELS: Record<AggregationFn, string> = {
  AVG: 'Mittelwert',
  MIN: 'Minimum',
  MAX: 'Maximum',
  SUM: 'Summe',
};

const DEFAULT_THRESHOLD_LEVELS = [80, 100];
const EMPTY_SOURCE_KEYS: string[] = [];

function normalizedLevels(levels: number[] | undefined): number[] {
  return [...new Set((levels ?? []).filter((level) => Number.isFinite(level)))]
    .sort((a, b) => a - b);
}

/** Template kinds whose data is fetched from the API by the card itself. */
const FETCH_KINDS = new Set([
  'aggTrend',
  'heatmap',
  'durationCurve',
  'dailyProfile',
  'correlationMatrix',
  'boxplot',
  'powerFactor',
  'exceedance',
  'quality',
  'dst',
  'seasonRadar',
]);

/**
 * Kinds that derive their result from a whole Betriebsmittel rather than a
 * single measurement: one fetch + one chart per component. Season radar is
 * included because a radar is per-component (its polygons are the picked
 * measurements of that component).
 */
const COMPONENT_GROUPED = new Set([
  'powerFactor', 'correlationMatrix', 'dst', 'quality', 'seasonRadar',
]);

/**
 * Kinds that should show one active fetched payload at a time. With multiple
 * signals/components these switch via a dropdown on the card instead of
 * rendering several charts in parallel.
 */
const DROPDOWN_KINDS = new Set(['heatmap', 'boxplot', 'histogram', 'correlationMatrix']);

/** Kinds that overlay multiple signals into a single chart (shared axis). */
const COMBINE_KINDS = new Set(['aggTrend', 'dailyProfile', 'durationCurve', 'powerFactor']);

/** One fetch unit — a signal (signal-level) or a component (component-grouped). */
interface FetchUnit {
  key: string;
  label: string;
  componentId: string;
  measurementTypes: string[];
  src: DashboardSeries;
}

function LiveConfigControls({
  template,
  config,
  resolutions,
  onChange,
}: {
  template: ChartTemplate;
  config: DynamicChartConfig;
  resolutions: ResolutionInfo[];
  onChange: (config: DynamicChartConfig) => void;
}) {
  const hasControls = template.needsThreshold
    || template.needsThresholdLevels
    || template.needsVoltageBand
    || template.needsAggregation
    || template.needsResolution
    || template.needsYAxisControl
    || template.needsHistogramMode
    || template.needsBoxplotGroupBy
    || template.needsBoxplotMode
    || template.needsCorrelationMethod;

  if (!hasControls) return null;

  const patch = (next: Partial<DynamicChartConfig>) => {
    onChange({ ...config, ...next });
  };
  const levels = config.thresholdLevels?.length ? config.thresholdLevels : template.thresholdLevelsDefault ?? DEFAULT_THRESHOLD_LEVELS;
  const levelNames = config.thresholdLevelNames ?? [];
  const levelColors = config.thresholdLevelColors ?? [];
  const updateLevel = (index: number, value: number) => {
    patch({ thresholdLevels: levels.map((level, i) => (i === index ? value : level)) });
  };
  const updateLevelName = (index: number, name: string) => {
    const nextNames = levels.map((_, i) => levelNames[i] ?? defaultThresholdLevelName(i, levels.length));
    nextNames[index] = name;
    patch({ thresholdLevelNames: nextNames });
  };
  const updateLevelColor = (index: number, color: string) => {
    const nextColors = levels.map((_, i) => normalizeThresholdLevelColor(levelColors[i], i, levels.length));
    nextColors[index] = normalizeThresholdLevelColor(color, index, levels.length);
    patch({ thresholdLevelColors: nextColors });
  };
  const addLevel = () => {
    const normalized = normalizedLevels(levels);
    const last = normalized[normalized.length - 1] ?? 100;
    patch({
      thresholdLevels: [...levels, last + 10],
      thresholdLevelColors: [
        ...levels.map((_, i) => normalizeThresholdLevelColor(levelColors[i], i, levels.length)),
        defaultThresholdLevelColor(levels.length, levels.length + 1),
      ],
    });
  };
  const removeLevel = (index: number) => {
    patch({
      thresholdLevels: levels.filter((_, i) => i !== index),
      thresholdLevelNames: levelNames.filter((_, i) => i !== index),
      thresholdLevelColors: levelColors.filter((_, i) => i !== index),
    });
  };

  return (
    <div className="mb-1 rounded border border-[var(--grid-border)] bg-[var(--grid-subpanel)] px-1 py-0.5">
      <div className="flex flex-wrap items-center gap-0.5">
        <span className="mr-0.5 shrink-0 text-[8px] font-semibold uppercase tracking-wide text-[var(--grid-muted)]">
          Live
        </span>
        {template.needsAggregation && (
          <label className="flex items-center gap-0.5 text-[9px] text-[var(--grid-muted)]">
            Aggregation
            <select
              value={config.aggregation ?? 'AVG'}
              onChange={(e) => patch({ aggregation: e.target.value as AggregationFn })}
              className="grid-form-input grid-form-input--compact h-5 min-w-20"
            >
              {(Object.keys(AGG_LABELS) as AggregationFn[]).map((fn) => (
                <option key={fn} value={fn}>{AGG_LABELS[fn]}</option>
              ))}
            </select>
          </label>
        )}

        {template.needsResolution && (
          <label className="flex items-center gap-0.5 text-[9px] text-[var(--grid-muted)]">
            Auflösung
            <select
              value={config.resolutionMinutes ?? 60}
              onChange={(e) => patch({ resolutionMinutes: Number(e.target.value) })}
              className="grid-form-input grid-form-input--compact h-5 min-w-20"
            >
              {resolutions.filter((r) => r.minutes > 0).map((r) => (
                <option key={r.minutes} value={r.minutes}>{r.label}</option>
              ))}
            </select>
          </label>
        )}

        {template.needsThreshold && (
          <label className="flex items-center gap-0.5 text-[9px] text-[var(--grid-muted)]">
            {template.thresholdLabel ?? 'Schwellwert'}
            <input
              type="number"
              value={config.threshold ?? template.thresholdDefault ?? 80}
              onChange={(e) => patch({ threshold: Number(e.target.value) })}
              className="grid-form-input grid-form-input--compact h-5 w-16"
            />
          </label>
        )}

        {template.needsVoltageBand && (
          <>
            <label className="flex items-center gap-0.5 text-[9px] text-[var(--grid-muted)]">
              U min %
              <input
                type="number"
                min={0}
                step={0.1}
                value={config.voltageMinPct ?? template.voltageMinPercentDefault ?? 90}
                onChange={(e) => patch({ voltageMinPct: Number(e.target.value) })}
                className="grid-form-input grid-form-input--compact h-5 w-14"
              />
            </label>
            <label className="flex items-center gap-0.5 text-[9px] text-[var(--grid-muted)]">
              U max %
              <input
                type="number"
                min={0}
                step={0.1}
                value={config.voltageMaxPct ?? template.voltageMaxPercentDefault ?? 110}
                onChange={(e) => patch({ voltageMaxPct: Number(e.target.value) })}
                className="grid-form-input grid-form-input--compact h-5 w-14"
              />
            </label>
          </>
        )}

        {template.needsThresholdLevels && (
          <>
            <span className="text-[9px] text-[var(--grid-muted)]">Schwellen</span>
            {levels.map((level, index) => {
              const tone = normalizeThresholdLevelColor(levelColors[index], index, levels.length);
              const fallbackLabel = defaultThresholdLevelName(index, levels.length);
              const label = levelNames[index] ?? fallbackLabel;
              return (
                <div key={index} className="flex h-5 items-center gap-0.5 rounded border border-[var(--grid-border-soft)] bg-[var(--grid-control)] px-0.5">
                  <ColorSwatchPicker
                    value={tone}
                    onChange={(color) => updateLevelColor(index, color)}
                    label={label}
                  />
                  <input
                    type="text"
                    value={label}
                    onChange={(e) => updateLevelName(index, e.target.value)}
                    className="grid-form-input grid-form-input--compact h-4 w-28"
                    aria-label={`${fallbackLabel} Name`}
                    title={`${fallbackLabel} Name`}
                  />
                  <input
                    type="number"
                    title={label}
                    value={Number.isFinite(level) ? level : ''}
                    onChange={(e) => updateLevel(index, Number(e.target.value))}
                    className="grid-form-input grid-form-input--compact h-4 w-12"
                  />
                  <button
                    type="button"
                    onClick={() => removeLevel(index)}
                    className="px-0.5 text-[10px] leading-none text-[var(--grid-muted)] transition-colors hover:text-[var(--grid-danger)]"
                    aria-label={`${label} entfernen`}
                    title={`${label} entfernen`}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              onClick={addLevel}
              className="h-5 rounded border border-[var(--grid-border)] bg-[var(--grid-control)] px-1 text-[9px] text-[var(--grid-text-soft)] transition-colors hover:bg-[var(--grid-control-hover)]"
            >
              + Stufe
            </button>
          </>
        )}

        {template.needsHistogramMode && (
          <label className="flex items-center gap-0.5 text-[9px] text-[var(--grid-muted)]">
            Ansicht
            <select
              value={config.histogramMode ?? 'single'}
              onChange={(e) => patch({ histogramMode: e.target.value as 'single' | 'combined' })}
              className="grid-form-input grid-form-input--compact h-5 min-w-20"
            >
              <option value="single">Einzeln</option>
              <option value="combined">Kombiniert</option>
            </select>
          </label>
        )}

        {template.needsBoxplotGroupBy && (
          <label className="flex items-center gap-0.5 text-[9px] text-[var(--grid-muted)]">
            Gruppierung
            <select
              value={config.boxplotGroupBy ?? 'hour'}
              onChange={(e) => patch({ boxplotGroupBy: e.target.value as DynamicChartConfig['boxplotGroupBy'] })}
              className="grid-form-input grid-form-input--compact h-5 min-w-24"
            >
              <option value="hour">Stunde</option>
              <option value="weekday">Wochentag</option>
              <option value="month">Monat</option>
              <option value="weekday_weekend">Werktag/Wochenende</option>
            </select>
          </label>
        )}

        {template.needsBoxplotMode && (
          <label className="flex items-center gap-0.5 text-[9px] text-[var(--grid-muted)]">
            Ansicht
            <select
              value={config.boxplotMode ?? 'single'}
              onChange={(e) => patch({ boxplotMode: e.target.value as 'single' | 'combined' })}
              className="grid-form-input grid-form-input--compact h-5 min-w-20"
            >
              <option value="single">Einzeln</option>
              <option value="combined">Kombiniert</option>
            </select>
          </label>
        )}

        {template.needsCorrelationMethod && (
          <label className="flex items-center gap-0.5 text-[9px] text-[var(--grid-muted)]">
            Methode
            <select
              value={config.correlationMethod ?? 'pearson'}
              onChange={(e) => patch({ correlationMethod: e.target.value as DynamicChartConfig['correlationMethod'] })}
              className="grid-form-input grid-form-input--compact h-5 min-w-28"
            >
              <option value="pearson">Pearson (linear)</option>
              <option value="spearman">Spearman (Rang)</option>
              <option value="kendall">Kendall (robust)</option>
            </select>
          </label>
        )}

        {template.needsYAxisControl && (
          <>
            <label className="flex items-center gap-0.5 text-[9px] text-[var(--grid-muted)]">
              Y-Achse
              <select
                value={config.yAxisScaleType ?? 'auto'}
                onChange={(e) => patch({ yAxisScaleType: e.target.value as 'auto' | 'manual' })}
                className="grid-form-input grid-form-input--compact h-5 min-w-16"
              >
                <option value="auto">Auto</option>
                <option value="manual">Manuell</option>
              </select>
            </label>
            {config.yAxisScaleType === 'manual' && (
              <>
                <label className="flex items-center gap-0.5 text-[9px] text-[var(--grid-muted)]">
                  Min
                  <input
                    type="number"
                    value={config.yAxisMin ?? ''}
                    onChange={(e) => patch({ yAxisMin: e.target.value === '' ? undefined : Number(e.target.value) })}
                    className="grid-form-input grid-form-input--compact h-5 w-16"
                  />
                </label>
                <label className="flex items-center gap-0.5 text-[9px] text-[var(--grid-muted)]">
                  Max
                  <input
                    type="number"
                    value={config.yAxisMax ?? ''}
                    onChange={(e) => patch({ yAxisMax: e.target.value === '' ? undefined : Number(e.target.value) })}
                    className="grid-form-input grid-form-input--compact h-5 w-16"
                  />
                </label>
                <label className="flex items-center gap-0.5 text-[9px] text-[var(--grid-muted)]">
                  <input
                    type="checkbox"
                    checked={config.yAxisLog ?? false}
                    onChange={(e) => patch({ yAxisLog: e.target.checked })}
                  />
                  Log
                </label>
              </>
            )}
          </>
        )}
      </div>
      {template.needsThresholdLevels && normalizedLevels(levels).length < 2 && (
        <div className="mt-0.5 text-[9px] text-[var(--grid-warning)]">
          Mindestens zwei Schwellen sind nötig.
        </div>
      )}
    </div>
  );
}

function extractError(err: unknown): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const axErr = err as { response?: { status?: number; data?: { detail?: string } } };
    const status = axErr.response?.status ?? '?';
    const detail = axErr.response?.data?.detail ?? '';
    return `${status} – ${detail || 'Unbekannter Serverfehler'}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

const CHART_FALLBACK = <GeneratingLoader minHeight={260} />;

/** One fetched payload tied to its source signal (for small multiples). */
interface FetchItem {
  key: string;
  label: string;
  data: unknown;
}

interface Props {
  instance: DashboardChartConfig;
  availableSeries: DashboardSeries[];
  /** Loaded raw timeseries (keyed by series key) for client-side templates. */
  dataMap: Record<string, TimeseriesData>;
  startIso?: string;
  endIso?: string;
  onRemove: (id: string) => void;
  onUpdateConfig: (id: string, config: DynamicChartConfig) => void;
  resolutions: ResolutionInfo[];
}

export default function DynamicChartCard({
  instance,
  availableSeries,
  dataMap,
  startIso,
  endIso,
  onRemove,
  onUpdateConfig,
  resolutions,
}: Props) {
  const template = getTemplate(instance.templateId);
  const rawConfig = instance.config ?? { sourceKeys: EMPTY_SOURCE_KEYS };
  const sourceKeys = Array.isArray(rawConfig.sourceKeys) ? rawConfig.sourceKeys : EMPTY_SOURCE_KEYS;
  const config: DynamicChartConfig = sourceKeys === rawConfig.sourceKeys
    ? rawConfig
    : { ...rawConfig, sourceKeys };

  // Resolve configured source keys to the live selection. A configured key
  // with no match means that signal was removed from the dashboard.
  const resolvedSources = useMemo(
    () => sourceKeys.map((key) => availableSeries.find((s) => s.key === key) ?? null),
    [sourceKeys, availableSeries],
  );
  const presentSources = useMemo(
    () => resolvedSources.filter((s): s is DashboardSeries => s !== null),
    [resolvedSources],
  );

  const missing = useMemo(() => {
    if (!template) return false;
    if (template.componentLevel) return presentSources.length === 0;
    if (template.arity === 'two') return !resolvedSources[0] || !resolvedSources[1];
    if (template.arity === 'three') return !resolvedSources[0] || !resolvedSources[1] || !resolvedSources[2];
    if (template.arity === 'multi') return presentSources.length === 0;
    return !resolvedSources[0];
  }, [template, resolvedSources, presentSources.length]);

  // Defense-in-depth: even though the picker gates on required measurements,
  // a signal can be removed after the card exists. Re-check here so we show a
  // clear "missing measurement" state instead of an empty/garbage plot.
  const missingMeasurements = useMemo(
    () => (template
      ? missingRequiredMeasurements(
          template.requiredComponentMeasurements,
          presentSources.map((s) => s.key),
          availableSeries,
        )
      : []),
    [template, presentSources, availableSeries],
  );

  // -- Fetch-based templates -----------------------------------------------
  const [items, setItems] = useState<FetchItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isFetchKind = !!template && FETCH_KINDS.has(template.kind);

  // Component-grouped charts derive their result from a whole Betriebsmittel:
  // one fetch (and one chart) per component, regardless of how many signals
  // identify it. Season radar additionally narrows to the picked measurements.
  const fetchUnits = useMemo<FetchUnit[]>(() => {
    if (!template) return [];
    if (COMPONENT_GROUPED.has(template.kind)) {
      const byComponent = new Map<string, FetchUnit>();
      for (const s of presentSources) {
        const existing = byComponent.get(s.componentId);
        if (existing) {
          if (!existing.measurementTypes.includes(s.measurementType)) {
            existing.measurementTypes.push(s.measurementType);
          }
        } else {
          byComponent.set(s.componentId, {
            key: s.componentId,
            label: `${s.facilityName} / ${s.componentName}`,
            componentId: s.componentId,
            measurementTypes: [s.measurementType],
            src: s,
          });
        }
      }
      return [...byComponent.values()];
    }
    return presentSources.map((s) => ({
      key: s.key, label: seriesLabel(s), componentId: s.componentId,
      measurementTypes: [s.measurementType], src: s,
    }));
  }, [template, presentSources]);

  // A stable signature so the fetch effect re-runs when the units change.
  const unitsSignature = fetchUnits.map((u) => `${u.key}:${u.measurementTypes.join('+')}`).join('|');

  useEffect(() => {
    if (!template || !isFetchKind || fetchUnits.length === 0) return;
    let active = true;
    setLoading(true);
    setError(null);

    const fetchOne = (unit: FetchUnit): Promise<unknown> => {
      const { src, componentId, measurementTypes } = unit;
      switch (template.kind) {
        case 'aggTrend':
          return getTimeseries(
            src.componentId, src.measurementType, startIso, endIso,
            config.resolutionMinutes || 60, undefined, undefined, config.aggregation ?? 'AVG',
          );
        case 'heatmap':
          return getHeatmap(src.componentId, src.measurementType, startIso, endIso);
        case 'durationCurve':
          return getDurationCurve(src.componentId, src.measurementType, startIso, endIso);
        case 'dailyProfile':
          return getDailyProfile(src.componentId, src.measurementType, startIso, endIso);
        case 'boxplot':
          return getBoxPlot(src.componentId, src.measurementType, startIso, endIso, config.boxplotGroupBy ?? 'hour');
        case 'exceedance':
          return getExceedance(src.componentId, src.measurementType, config.threshold ?? 80, startIso, endIso);
        // -- Component-grouped --
        case 'correlationMatrix': {
          const types = Array.from(new Set(
            availableSeries.filter((s) => s.componentId === componentId).map((s) => s.measurementType),
          ));
          return getCorrelationMatrix(componentId, types, startIso, endIso);
        }
        case 'powerFactor':
          return getPowerFactor(componentId, startIso, endIso);
        case 'quality':
          return getQuality(componentId, startIso, endIso);
        case 'dst':
          return getDSTEvents(componentId, startIso, endIso);
        case 'seasonRadar':
          // Only compute the picked measurements for this component.
          return getSeasonRadar(componentId, startIso, endIso, measurementTypes.join(','));
        default:
          return Promise.resolve(null);
      }
    };

    // Cap concurrency so a card with many source signals doesn't fire N heavy
    // Oracle reads at once — same discipline as the main timeseries fetch path.
    const CONCURRENCY = 2;
    const results: FetchItem[] = new Array(fetchUnits.length);
    let cursor = 0;
    const runNext = async (): Promise<void> => {
      const index = cursor++;
      if (index >= fetchUnits.length || !active) return;
      const unit = fetchUnits[index];
      results[index] = { key: unit.key, label: unit.label, data: await fetchOne(unit) };
      return runNext();
    };

    Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, fetchUnits.length) }, () => runNext()),
    )
      .then(() => {
        if (!active) return;
        setItems(results);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setError(extractError(err));
        setItems(null);
        setLoading(false);
      });

    return () => { active = false; };
  }, [
    template, isFetchKind, fetchUnits, unitsSignature, availableSeries,
    config.aggregation, config.resolutionMinutes, config.threshold, config.boxplotGroupBy,
    startIso, endIso,
  ]);

  // -- Local controls -------------------------------------------------------
  const [peakPeriod, setPeakPeriod] = useState<PeakDemandPeriod>('month');
  const [peakIndex, setPeakIndex] = useState(0);
  // Active signal for dropdown-switched charts (heatmap / boxplot / histogram).
  const [activeIdx, setActiveIdx] = useState(0);
  const peakRowsByPeriod = useMemo(
    () => (template?.kind === 'peakDemand' ? buildPeakRows(presentSources, dataMap) : null),
    [template, presentSources, dataMap],
  );
  const peakRows = peakRowsByPeriod ? peakRowsByPeriod[peakPeriod] : [];

  if (!template) {
    return (
      <CardShell id={instance.id} title="Unbekanntes Diagramm" subtitle="" onRemove={onRemove}>
        <InfoState text="Diese Diagrammvorlage ist nicht mehr verfügbar." />
      </CardShell>
    );
  }

  // Self-describing subtitle: the chart stays visually stable when the data
  // changes, but its subtitle always carries a date stamp (and the active
  // resolution when the template uses one) reflecting the current parameters —
  // so the card and any exported screenshot say which window they cover.
  const resolutionLabel = template.needsResolution
    ? resolutions.find((r) => r.minutes === (config.resolutionMinutes ?? 60))?.label
    : undefined;
  const subtitle = [
    ARITY_LABELS[template.arity],
    resolutionLabel ? `Auflösung ${resolutionLabel}` : null,
  ].filter(Boolean).join(' · ');
  const sourceSummary = presentSources.map((s) => seriesLabel(s)).join(', ');

  let body: ReactNode;

  if (missing) {
    body = (
      <InfoState
        tone="warn"
        text="Quelle nicht verfügbar — das zugehörige Signal wurde aus der Auswahl entfernt. Signal erneut hinzufügen, um dieses Diagramm wiederherzustellen."
      />
    );
  } else if (missingMeasurements.length > 0) {
    body = (
      <InfoState
        tone="warn"
        text={`Fehlende Messgröße(n) am Betriebsmittel: ${missingMeasurements
          .map((m) => MTYPE_LABELS[m] ?? m)
          .join(', ')}. Diese Auswertung benötigt sie für eine korrekte Berechnung.`}
      />
    );
  } else if (isFetchKind) {
    if (error) {
      body = <ErrorState message={error} />;
    } else if (loading || items == null) {
      body = <GeneratingLoader />;
    } else if (items.length === 0) {
      body = <InfoState text="Keine Daten im Zeitraum." />;
    } else {
      const useBoxplotCombined = template.kind === 'boxplot' && config.boxplotMode === 'combined';
      const useDropdown = DROPDOWN_KINDS.has(template.kind) && items.length > 1 && !useBoxplotCombined;
      const idx = Math.min(activeIdx, items.length - 1);
      body = (
        <ErrorBoundary label={template.name}>
          <Suspense fallback={CHART_FALLBACK}>
            {items.length === 1 ? (
              renderFetchChart(template, items[0].data, config)
            ) : useBoxplotCombined ? (
              <BoxPlotCombinedChart
                seriesList={items.map((it) => ({ label: it.label, data: it.data as BoxPlotData }))}
                {...yAxisProps(config)}
              />
            ) : useDropdown ? (
              <div>
                <SignalSwitch
                  items={items}
                  value={idx}
                  onChange={setActiveIdx}
                  label={template.kind === 'correlationMatrix' ? 'Betriebsmittel:' : 'Signal:'}
                />
                {renderFetchChart(template, items[idx].data, config)}
              </div>
            ) : COMBINE_KINDS.has(template.kind) ? (
              renderCombinedFetchChart(template, items, config)
            ) : (
              // Component-grouped charts (one per Betriebsmittel) lay out as
              // small multiples; each item already combines its measurements.
              <ChartGrid>
                {items.map((it) => (
                  <ChartBlock key={it.key} label={it.label}>{renderFetchChart(template, it.data, config)}</ChartBlock>
                ))}
              </ChartGrid>
            )}
          </Suspense>
        </ErrorBoundary>
      );
    }
  } else {
    // Client-side templates derive from the already-loaded raw timeseries.
    body = renderClientChart({
      template,
      presentSources,
      dataMap,
      config,
      peakRows,
      peakIndex,
      setPeakIndex,
      peakPeriod,
      setPeakPeriod,
      activeIdx,
      setActiveIdx,
    });
  }

  return (
    <CardShell id={instance.id} title={template.name} subtitle={subtitle} sourceSummary={sourceSummary} onRemove={onRemove}>
      <LiveConfigControls
        template={template}
        config={config}
        resolutions={resolutions}
        onChange={(nextConfig) => onUpdateConfig(instance.id, nextConfig)}
      />
      {body}
    </CardShell>
  );
}

// -- Rendering helpers ------------------------------------------------------

function yAxisProps(config: DynamicChartConfig) {
  return {
    yAxisScaleType: config.yAxisScaleType,
    yAxisMin: config.yAxisMin,
    yAxisMax: config.yAxisMax,
    yAxisLog: config.yAxisLog,
  };
}

/** Common <TimeseriesChart> props derived from a card's template + live
 * config: the Y-axis scaling controls plus a descriptive export filename
 * base (the template name), so downloaded PNGs are self-labelling. */
function tsChartProps(template: ChartTemplate, config: DynamicChartConfig) {
  return {
    ...yAxisProps(config),
    exportBaseName: template.name,
  };
}

function renderFetchChart(template: ChartTemplate, payload: unknown, config: DynamicChartConfig): ReactNode {
  switch (template.kind) {
    case 'aggTrend': {
      const data = payload as TimeseriesData;
      if (!data.data.length) return <InfoState text="Keine Daten im Zeitraum." />;
      return <TimeseriesChart seriesList={[data]} {...tsChartProps(template, config)} />;
    }
    case 'heatmap': {
      const data = payload as HeatmapData;
      if (!data.data.length) return <InfoState text="Keine Daten im Zeitraum." />;
      return <HeatmapChart data={data} />;
    }
    case 'durationCurve': {
      const data = payload as DurationCurveData;
      if (!data.data.length) return <InfoState text="Keine Daten im Zeitraum." />;
      return <DurationCurveChart data={data} {...yAxisProps(config)} />;
    }
    case 'dailyProfile':
      return <DailyProfileChart data={payload as DailyProfileData} {...yAxisProps(config)} />;
    case 'correlationMatrix':
      return <CorrelationMatrixChart data={payload as CorrelationMatrixData} />;
    case 'boxplot': {
      const data = payload as BoxPlotData;
      if (!data.items.length) return <InfoState text="Keine Daten im Zeitraum." />;
      return <BoxPlotChart data={data} {...yAxisProps(config)} />;
    }
    case 'powerFactor': {
      const data = payload as PowerFactorData;
      if (!data.data.length) return <InfoState text="Keine P/Q/S-Daten für den Leistungsfaktor." />;
      return <PowerFactorChart data={data} mode="timeseries" {...yAxisProps(config)} />;
    }
    case 'exceedance':
      return <ExceedanceChart data={payload as ExceedanceData} {...yAxisProps(config)} />;
    case 'quality': {
      const data = payload as QualityData;
      if (!data.gap_heatmap.length) return <InfoState text="Keine Lückendaten im Zeitraum." />;
      return <QualityChart data={data} />;
    }
    case 'dst':
      return <DSTChart data={payload as DSTData} />;
    case 'seasonRadar': {
      const data = payload as SeasonRadarData;
      if (!data.series.length) return <InfoState text="Keine saisonalen Daten im Zeitraum." />;
      return <SeasonRadarChart data={data} />;
    }
    default:
      return null;
  }
}

/** Overlay several fetched payloads into one chart (shared-axis combine). */
function renderCombinedFetchChart(template: ChartTemplate, items: FetchItem[], config: DynamicChartConfig): ReactNode {
  switch (template.kind) {
    case 'aggTrend': {
      const seriesList = (items as { data: TimeseriesData }[])
        .map((it) => it.data)
        .filter((data) => data.data.length > 0);
      if (seriesList.length === 0) return <InfoState text="Keine Daten im Zeitraum." />;
      return <TimeseriesChart seriesList={seriesList} {...tsChartProps(template, config)} />;
    }
    case 'dailyProfile': {
      const profiles = (items as { label: string; data: DailyProfileData }[])
        .filter((it) => it.data.weekday_avg.length > 0 || it.data.weekend_avg.length > 0);
      if (profiles.length === 0) return <InfoState text="Keine Daten im Zeitraum." />;
      return (
        <DailyProfileChart
          data={profiles[0].data}
          series={profiles.map((it) => ({ label: it.label, data: it.data }))}
          {...yAxisProps(config)}
        />
      );
    }
    case 'durationCurve': {
      const curves = (items as { label: string; data: DurationCurveData }[])
        .filter((it) => it.data.data.length > 0)
        .map((it) => ({ label: it.label, unit: it.data.unit, data: it.data.data }));
      if (curves.length === 0) return <InfoState text="Keine Daten im Zeitraum." />;
      return <DurationCurveChart data={items[0].data as DurationCurveData} series={curves} {...yAxisProps(config)} />;
    }
    case 'powerFactor': {
      const factors = (items as { label: string; data: PowerFactorData }[])
        .filter((it) => it.data.data.length > 0);
      if (factors.length === 0) return <InfoState text="Keine P/Q/S-Daten für den Leistungsfaktor." />;
      return (
        <PowerFactorChart
          data={factors[0].data}
          series={factors.map((it) => ({ label: it.label, data: it.data }))}
          mode="timeseries"
          {...yAxisProps(config)}
        />
      );
    }
    default:
      return null;
  }
}

interface ClientRenderArgs {
  template: ChartTemplate;
  presentSources: DashboardSeries[];
  dataMap: Record<string, TimeseriesData>;
  config: DynamicChartConfig;
  peakRows: ReturnType<typeof buildPeakRows>[PeakDemandPeriod];
  peakIndex: number;
  setPeakIndex: (i: number) => void;
  peakPeriod: PeakDemandPeriod;
  setPeakPeriod: (p: PeakDemandPeriod) => void;
  activeIdx: number;
  setActiveIdx: (i: number) => void;
}

function renderClientChart(args: ClientRenderArgs): ReactNode {
  const { template, presentSources, dataMap, config, activeIdx, setActiveIdx } = args;

  const wrap = (node: ReactNode) => (
    <ErrorBoundary label={template.name}>
      <Suspense fallback={CHART_FALLBACK}>{node}</Suspense>
    </ErrorBoundary>
  );

  switch (template.kind) {
    case 'overlay': {
      const loaded = presentSources
        .map((s) => dataMap[s.key])
        .filter((d): d is TimeseriesData => !!d);
      if (loaded.length < presentSources.length) return <GeneratingLoader />;
      if (loaded.length === 0) return <InfoState text="Keine Daten geladen." />;
      return wrap(<TimeseriesChart seriesList={loaded} {...tsChartProps(template, config)} />);
    }
    case 'histogram': {
      const loaded = presentSources.map((s) => ({ s, data: dataMap[s.key] }));
      if (loaded.some((x) => !x.data)) return <GeneratingLoader />;
      const usable = loaded.filter((x) => x.data.data.length > 0);
      if (usable.length === 0) return <InfoState text="Keine Daten im Zeitraum." />;
      if (usable.length === 1) {
        return wrap(<TimeseriesHistogramChart series={usable[0].data} binCount={24} mode="count" cumulative={false} {...yAxisProps(config)} />);
      }
      // Combined view: all selected signals overlaid in one binned chart.
      if (config.histogramMode === 'combined') {
        return wrap(
          <HistogramCombinedChart
            seriesList={usable.map(({ s, data }) => ({ label: seriesLabel(s), data }))}
            binCount={24}
            {...yAxisProps(config)}
          />,
        );
      }
      // Single view (default): switch the active signal via a dropdown.
      const idx = Math.min(activeIdx, usable.length - 1);
      return wrap(
        <div>
          <SignalSwitch
            items={usable.map(({ s }) => ({ key: s.key, label: seriesLabel(s) }))}
            value={idx}
            onChange={setActiveIdx}
          />
          <TimeseriesHistogramChart series={usable[idx].data} binCount={24} mode="count" cumulative={false} {...yAxisProps(config)} />
        </div>,
      );
    }
    case 'correlationScatter': {
      const [x, y] = presentSources;
      const xData = dataMap[x.key];
      const yData = dataMap[y.key];
      if (!xData || !yData) return <GeneratingLoader />;
      try {
        return wrap(<CorrelationChart data={buildCorrelation(x, y, xData, yData, config.correlationMethod)} {...yAxisProps(config)} />);
      } catch (err) {
        return <ErrorState message={extractError(err)} />;
      }
    }
    case 'peakDemand': {
      const { peakRows, peakIndex, setPeakIndex, peakPeriod, setPeakPeriod } = args;
      const hasLoaded = presentSources.some((s) => s.measurementType === 'P' && dataMap[s.key]);
      if (!hasLoaded) return <GeneratingLoader />;
      if (peakRows.length === 0) return <InfoState text="Wirkleistung (P) auswählen, um Spitzenlasten zu berechnen." />;
      const safeIndex = Math.min(peakIndex, peakRows.length - 1);
      return (
        <div>
          <div className="mb-3 inline-flex overflow-hidden rounded border border-gray-600 text-xs">
            {(Object.keys(PEAK_PERIOD_LABELS) as PeakDemandPeriod[]).map((period) => (
              <button
                key={period}
                type="button"
                onClick={() => { setPeakPeriod(period); setPeakIndex(0); }}
                className={`px-2.5 py-1 transition-colors ${
                  peakPeriod === period ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white'
                }`}
              >
                {PEAK_PERIOD_LABELS[period]}
              </button>
            ))}
          </div>
          {wrap(<PeakDemandChart rows={peakRows} selectedIndex={safeIndex} onSelect={setPeakIndex} {...yAxisProps(config)} />)}
        </div>
      );
    }
    // -- Client-side derived charts (reuse existing chart components) --------
    case 'pqQuadrant':
    case 'quScatter': {
      const [x, y] = presentSources;
      if (!x || !y) return <InfoState text="Bitte zwei Signale wählen." />;
      const xData = dataMap[x.key];
      const yData = dataMap[y.key];
      if (!xData || !yData) return <GeneratingLoader />;
      try {
        return wrap(<CorrelationChart data={buildCorrelation(x, y, xData, yData)} {...yAxisProps(config)} />);
      } catch (err) {
        return <ErrorState message={extractError(err)} />;
      }
    }
    case 'correlationScatter3':
    case 'correlationScatter3d': {
      const [x, y, z] = presentSources;
      const is3D = template.kind === 'correlationScatter3d';
      if (!x || !y || !z) return <InfoState text={is3D ? 'Bitte drei Signale wählen (X, Y, Z).' : 'Bitte drei Signale wählen (X, Y, Farbe).'} />;
      const xData = dataMap[x.key];
      const yData = dataMap[y.key];
      const zData = dataMap[z.key];
      if (!xData || !yData || !zData) return <GeneratingLoader />;
      try {
        const correlationData = buildCorrelation3(x, y, z, xData, yData, zData, config.correlationMethod);
        return wrap(
          is3D
            ? <Correlation3DChart data={correlationData} {...yAxisProps(config)} />
            : <CorrelationChart data={correlationData} {...yAxisProps(config)} />,
        );
      } catch (err) {
        return <ErrorState message={extractError(err)} />;
      }
    }
    case 'energyIntegral': {
      const s = presentSources[0];
      const d = dataMap[s.key];
      if (!d) return <GeneratingLoader />;
      if (!d.data.length) return <InfoState text="Keine Daten im Zeitraum." />;
      return wrap(<TimeseriesChart seriesList={[buildEnergyIntegral(s, d)]} {...tsChartProps(template, config)} />);
    }
    case 'lossesEfficiency': {
      const [a, b] = presentSources;
      if (!a || !b) return <InfoState text="Bitte zwei P-Signale wählen (Ein- und Ausspeisung)." />;
      const ad = dataMap[a.key];
      const bd = dataMap[b.key];
      if (!ad || !bd) return <GeneratingLoader />;
      const losses = buildLosses(ad, bd, `${a.componentName} − ${b.componentName}`);
      if (!losses.data.length) return <InfoState text="Keine gemeinsamen Zeitpunkte für die Differenz." />;
      return wrap(<TimeseriesChart seriesList={[losses]} {...tsChartProps(template, config)} />);
    }
    case 'assetLoading': {
      const s = presentSources[0];
      const d = dataMap[s.key];
      if (!d) return <GeneratingLoader />;
      if (!d.data.length) return <InfoState text="Keine Daten im Zeitraum." />;
      return wrap(<TimeseriesChart seriesList={[buildLoading(s, d, config.threshold ?? 100)]} {...tsChartProps(template, config)} />);
    }
    case 'overloadDuration': {
      const s = presentSources[0];
      const d = dataMap[s.key];
      if (!d) return <GeneratingLoader />;
      if (!d.data.length) return <InfoState text="Keine Daten im Zeitraum." />;
      return wrap(<DurationCurveChart data={buildOverloadDuration(s, d, config.threshold ?? 100)} {...yAxisProps(config)} />);
    }
    case 'rollingEnvelope': {
      const win = Math.max(2, Math.round((config.resolutionMinutes ?? 60) / 15));
      const loaded = presentSources.map((s) => ({ s, data: dataMap[s.key] }));
      if (loaded.some((x) => !x.data)) return <GeneratingLoader />;
      const seriesList = loaded.flatMap(({ s, data }) => {
        if (!data?.data.length) return [];
        return [
          {
            ...data,
            component_name: `${s.facilityName} / ${s.componentName}`,
          },
          buildRollingMean(
            { ...s, componentName: `${s.facilityName} / ${s.componentName}` },
            data,
            win,
          ),
        ];
      });
      if (seriesList.length === 0) return <InfoState text="Keine Daten im Zeitraum." />;
      return wrap(<TimeseriesChart seriesList={seriesList} {...tsChartProps(template, config)} />);
    }
    case 'thresholdBands': {
      const s = presentSources[0];
      const d = dataMap[s.key];
      if (!d) return <GeneratingLoader />;
      if (!d.data.length) return <InfoState text="Keine Daten im Zeitraum." />;
      const entries = normalizeThresholdLevelEntries(
        config.thresholdLevels,
        config.thresholdLevelNames,
        config.thresholdLevelColors,
      );
      // Fewer than 2 levels just means no/one threshold line is drawn — the
      // signal itself should stay visible; the control bar already shows a
      // hint to add more levels.
      return wrap(
        <TimeseriesChart
          seriesList={[d]}
          thresholdLevels={entries.map((entry) => entry.value)}
          thresholdLevelNames={entries.map((entry) => entry.name)}
          thresholdLevelColors={entries.map((entry) => entry.color)}
          {...tsChartProps(template, config)}
        />,
      );
    }
    case 'anomalyScore': {
      const s = presentSources[0];
      const d = dataMap[s.key];
      if (!d) return <GeneratingLoader />;
      if (!d.data.length) return <InfoState text="Keine Daten im Zeitraum." />;
      // Baseline window ≥ ~1 day (96×15 min) so the rolling z-score flags
      // deviations from the normal daily cycle instead of tracking the cycle.
      const win = Math.max(96, Math.round((config.resolutionMinutes ?? 1440) / 15));
      return wrap(<TimeseriesChart seriesList={[buildAnomalyScore(s, d, win)]} {...tsChartProps(template, config)} />);
    }
    case 'voltageCompliance': {
      const s = presentSources[0];
      const d = dataMap[s.key];
      if (!d) return <GeneratingLoader />;
      if (!d.data.length) return <InfoState text="Keine Daten im Zeitraum." />;
      return wrap(
        <TimeseriesChart
          seriesList={buildVoltageBand(
            s,
            d,
            config.threshold ?? 0, // 0 → auto-derive nominal from the data median
            config.voltageMinPct ?? 90,
            config.voltageMaxPct ?? 110,
          )}
          {...tsChartProps(template, config)}
        />,
      );
    }
    default:
      return null;
  }
}

// -- Presentational shells --------------------------------------------------

/** Responsive grid used to lay out small multiples (one chart per signal). */
function ChartGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{children}</div>;
}

function ChartBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded border border-gray-700 bg-gray-900/40 p-3">
      <div className="mb-2 truncate text-xs text-gray-400" title={label}>{label}</div>
      {children}
    </div>
  );
}

/** Dropdown to switch the active signal for charts that can't share axes. */
function SignalSwitch({
  items, value, onChange, label = 'Signal:',
}: {
  items: { key: string; label: string }[];
  value: number;
  onChange: (i: number) => void;
  label?: string;
}) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="text-xs text-gray-400">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded border border-gray-600 bg-gray-700 px-2 py-1 text-xs text-white focus:outline-none"
      >
        {items.map((it, i) => (
          <option key={it.key} value={i}>{it.label}</option>
        ))}
      </select>
    </div>
  );
}

interface CardShellProps {
  id: string;
  title: string;
  subtitle: string;
  sourceSummary?: string;
  onRemove: (id: string) => void;
  children: ReactNode;
}

function CardShell({ id, title, subtitle, sourceSummary, onRemove, children }: CardShellProps) {
  return (
    <SectionCard title={title} hint={subtitle} actions={
      <button type="button" onClick={() => onRemove(id)} className="shrink-0 text-xs text-gray-400 transition-colors hover:text-red-400" title="Diagramm entfernen" aria-label="Diagramm entfernen">✕</button>
    }>
      {sourceSummary && <p className="mb-2 truncate text-xs text-gray-500" title={sourceSummary}>{sourceSummary}</p>}
      {children}
    </SectionCard>
  );
}

function InfoState({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'warn' }) {
  return (
    <div
      className={`flex min-h-[160px] items-center justify-center rounded border px-4 text-center text-sm ${
        tone === 'warn'
          ? 'border-amber-700/40 bg-amber-900/10 text-amber-300'
          : 'border-gray-700 bg-gray-900/40 text-gray-500'
      }`}
    >
      {text}
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-3 rounded border border-red-800/40 bg-red-900/20 px-4 py-3">
      <span className="shrink-0 text-xl text-red-400">⚠</span>
      <div>
        <div className="text-sm font-medium text-red-300">Fehler beim Laden</div>
        <div className="mt-1 font-mono text-xs text-red-400/80">{message}</div>
      </div>
    </div>
  );
}
