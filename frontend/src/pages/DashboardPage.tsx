// @refresh reset  ← force full remount on hot reload so stale React state
// (e.g. resolutions carrying a non-array HMR-preserved value) never leaks into
// child components.
import { Fragment, useEffect, useState, useCallback, useMemo, useRef, lazy, Suspense, type PointerEvent } from 'react';
import {
  getFacilities,
  getComponentsByFacility,
  getMeasurementTypes,
  getTimeseries,
  getHeatmap,
  getResolutions,
  getShare,
  clearCache,
  RawRangeTooLargeError,
  type Facility,
  type GridComponent,
  type MeasurementTypeInfo,
  type ResolutionInfo,
  type TimeseriesData,
  type HeatmapData,
} from '../api/client';
// Chart components are lazy-loaded. Each one pulls in its slice of ECharts
// (~150-300 KB) as a separate chunk, so the dashboard's first paint only
// downloads the bare frame + dropdowns. Charts then stream in as the user
// scrolls / switches tabs.
const TimeseriesChart          = lazy(() => import('../components/charts/TimeseriesChart'));
const HeatmapChart             = lazy(() => import('../components/charts/HeatmapChart'));
const PeakDemandChart          = lazy(() => import('../components/charts/PeakDemandChart'));
const GridMapLibre             = lazy(() => import('../map/components/GridMapLibre'));
// Types are erased at compile time so a plain `import type` keeps the
// chunk split clean — they don't pull the runtime module into the main bundle.
import type {
  PeakDemandContribution,
  PeakDemandPeriod,
  PeakDemandRow,
} from '../components/charts/PeakDemandChart';
import type { MapLayerMode } from '../components/charts/GridMapChart';
import ErrorBoundary from '../components/ErrorBoundary';
import DataSection from '../components/DataSection';
import SearchableDropdown from '../components/SearchableDropdown';
import DynamicChartCard from '../components/DynamicChartCard';
import ChartTemplatePicker from '../components/ChartTemplatePicker';
import type { DashboardChartConfig, DynamicChartConfig } from '../util/dynamicCharts';
import {
  readViewFromUrl,
  readShareIdFromUrl,
  saveLocalView,
  loadLocalView,
  clearLocalView,
  type SharedView,
} from '../util/shareView';
import { useInView } from '../hooks/useInView';
import { logError } from '../debug/debugLog';
import { formatChartNumber } from '../components/charts/format';
import type { MockStation, MockTopology } from '../components/charts/gridMockData';
import type { GridTopologyCompat } from '../map/types';
import CinematicThemeSwitch from '../components/ui/cinematic-theme-switcher';
import { matchStation, matchAll as matchAllStations, type MatchResult } from '../util/facilityMatcher';
import { fallbackGridTopology } from '../api/gridTopology';
import { applyGridThemeMode, storedThemeMode, type ThemeMode } from '../util/theme';
import AnimatedButton from '../components/ui/AnimatedButton';
import OutageManagement from '../components/OutageManagement';
import { PICKER_TEMPLATES } from '../components/charts/chartTemplates';
import { SectionCard } from '../components/across/shared';
import AcrossScenarios from '../components/across/AcrossScenarios';
import { openSection, type SummarySection } from '../util/acrossScenarios';
import DatabasePicker from '../components/DatabasePicker';
import GeneratingLoader from '../components/ui/GeneratingLoader';
import { useUiConfig } from '../config/uiConfig';

/** Suspense fallback while a lazy chart chunk loads. Delegates to the shared loader. */
function ChartFallback({ height = 300 }: { height?: number }) {
  return <GeneratingLoader minHeight={height} />;
}

function extractError(err: unknown): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const axErr = err as { response?: { status?: number; data?: { detail?: string } }; config?: { url?: string } };
    const status = axErr.response?.status ?? '?';
    const detail = axErr.response?.data?.detail ?? '';
    const url = axErr.config?.url ?? '';
    return `${status} – ${detail || 'Unbekannter Serverfehler'} (${url})`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

const MTYPE_LABELS: Record<string, string> = {
  L: 'Auslastung',
  LOSS: 'Verluste',
  P: 'Wirkleistung (P)',
  Q: 'Blindleistung (Q)',
  S: 'Scheinleistung (S)',
  U: 'Spannung (U)',
  I: 'Strom (I)',
};

interface SelectedSeries {
  key: string;
  facilityName: string;
  facilityId: string;
  componentId: string;
  componentName: string;
  measurementType: string;
}

function seriesLabel(series: SelectedSeries): string {
  const measurement = MTYPE_LABELS[series.measurementType] ?? series.measurementType;
  return `${series.facilityName} / ${series.componentName} - ${measurement}`;
}

// Desktop app can override this at runtime via Einstellungen > Karte.
// Falls back to the build-time VITE_ENABLE_GRID_MAP flag.
const ENABLE_GRID_MAP = false;

const MAP_LAYER_OPTIONS: { id: MapLayerMode; label: string }[] = [
  { id: 'grid', label: 'Default' },
  { id: 'satellite', label: 'Sat' },
];

const NAV_SECTIONS = [
  { id: 'map-selection', label: 'Zusammenfassung', panel: null },
  { id: 'timeseries-panel', label: 'Zeitreihe', panel: 'timeseries' },
  { id: 'heatmap-panel', label: 'Heatmap', panel: 'heatmap' },
  { id: 'peak-demand-chart-panel', label: 'Peak Demand', panel: 'peakDemand' },
  { id: 'custom-charts-panel', label: 'Diagramme', panel: null },
] as const;


const PEAK_PERIOD_LABELS: Record<PeakDemandPeriod, string> = {
  day: 'Täglich',
  week: 'Wöchentlich',
  month: 'Monatlich',
};

const CHART_HINTS = {
  timeseries: 'Vollständige Simulationsreihen der ausgewählten Messgrößen.',
  peakDemand: 'Spitzenlast aus allen ausgewählten Wirkleistungsreihen; zeigt Tages-, Wochen- oder Monatsspitzen und Komponentenbeiträge.',
  aggregation: 'Zusätzliche Diagramme mit wählbarer Aggregation wie Mittelwert, Minimum, Maximum oder Summe.',
  heatmap: 'Typische Last- oder Spannungsmuster nach Wochentag und Stunde.',
} as const;

/** Optional views. Only the summary is standard; these appear when the user adds them.
 * Display labels for the remove button and the "add view" row. */
const REMOVABLE_PANEL_LABELS: Record<string, string> = {
  timeseries: 'Zeitreihen-Overlay',
  heatmap: 'Heatmap',
  peakDemand: 'Peak Demand Analysis',
};

/** Optional views offered under the summary. Peak demand needs active power, which the PowerFactory export does not contain. */
const OFFERED_PANELS = Object.entries(REMOVABLE_PANEL_LABELS).filter(([id]) => id !== 'peakDemand');

/** Small "x" button on an optional view's header; removes it again. */
function RemovePanelButton({ onRemove, label }: { onRemove: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label={`${label} entfernen`}
      title={`${label} entfernen`}
      className="ml-2 rounded px-1.5 py-0.5 text-gray-500 transition-colors hover:bg-red-900/30 hover:text-red-400"
    >
      ✕
    </button>
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isoWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return { year, week };
}

function peakPeriod(timestamp: string, period: PeakDemandPeriod): { key: string; label: string } {
  const d = new Date(timestamp);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  if (period === 'day') {
    const key = `${year}-${pad2(month)}-${pad2(d.getUTCDate())}`;
    return { key, label: key };
  }
  if (period === 'week') {
    const { year: weekYear, week } = isoWeek(d);
    return { key: `${weekYear}-W${pad2(week)}`, label: `KW ${pad2(week)}/${weekYear}` };
  }
  const key = `${year}-${pad2(month)}`;
  return { key, label: key };
}

function buildPeakDemandRows(
  selectedSeries: SelectedSeries[],
  dataMap: Record<string, TimeseriesData>,
): Record<PeakDemandPeriod, PeakDemandRow[]> {
  const pointsByTimestamp = new Map<string, {
    timestamp: string;
    total: number;
    unit: string;
    contributions: Omit<PeakDemandContribution, 'percent'>[];
  }>();

  selectedSeries
    .filter((series) => series.measurementType === 'P')
    .forEach((series) => {
      const data = dataMap[series.key];
      if (!data) return;
      data.data.forEach((point) => {
        if (!Number.isFinite(point.value)) return;
        const entry = pointsByTimestamp.get(point.timestamp) ?? {
          timestamp: point.timestamp,
          total: 0,
          unit: data.unit,
          contributions: [],
        };
        entry.total += point.value;
        entry.contributions.push({
          key: series.key,
          label: `${series.facilityName} / ${series.componentName}`,
          value: point.value,
        });
        pointsByTimestamp.set(point.timestamp, entry);
      });
    });

  const grouped: Record<PeakDemandPeriod, Map<string, PeakDemandRow>> = {
    day: new Map(),
    week: new Map(),
    month: new Map(),
  };

  pointsByTimestamp.forEach((sample) => {
    (Object.keys(grouped) as PeakDemandPeriod[]).forEach((period) => {
      const { key, label } = peakPeriod(sample.timestamp, period);
      const current = grouped[period].get(key);
      if (current && current.value >= sample.total) return;
      const denominator = sample.total !== 0
        ? sample.total
        : sample.contributions.reduce((sum, c) => sum + Math.abs(c.value), 0) || 1;
      const contributions = sample.contributions
        .map((c) => ({ ...c, percent: (c.value / denominator) * 100 }))
        .sort((a, b) => b.value - a.value);
      grouped[period].set(key, {
        periodKey: key,
        periodLabel: label,
        timestamp: sample.timestamp,
        value: sample.total,
        unit: sample.unit,
        contributions,
      });
    });
  });

  return {
    day: Array.from(grouped.day.values()).sort((a, b) => a.periodKey.localeCompare(b.periodKey)),
    week: Array.from(grouped.week.values()).sort((a, b) => a.periodKey.localeCompare(b.periodKey)),
    month: Array.from(grouped.month.values()).sort((a, b) => a.periodKey.localeCompare(b.periodKey)),
  };
}

function formatPeakTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function DashboardPage() {
  const uiConfig = useUiConfig();
  const initialShareId = useMemo(() => readShareIdFromUrl(), []);
  // Restore the view once on mount. A ?s=<id> share link is loaded async
  // (see effect below), so start empty in that case; otherwise fall back to a
  // legacy inline ?view= link, then to the locally-persisted view. This makes
  // a reload (or recovery after a dropped connection) lossless.
  const initialView = useMemo(
    () => (initialShareId ? null : readViewFromUrl() ?? loadLocalView()),
    [initialShareId],
  );
  // Selection to restore from a shared link / localStorage. The facility ->
  // component -> measurement cascade effects below reset their child selection
  // whenever the parent changes; without this they would wipe a restored
  // selection on the first pass. Honored once, then cleared.
  const restoreRef = useRef<{ fac: string | null; cmp: string | null; mt: string } | null>(
    initialView ? { fac: initialView.fac, cmp: initialView.cmp, mt: initialView.mt } : null,
  );
  // Gate the "auto-select first facility" fallback until a pending share has
  // loaded, so it can't claim the picker before the shared facility arrives.
  const [shareSettled, setShareSettled] = useState(!initialShareId);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [selectedFacilityId, setSelectedFacilityId] = useState<string | null>(initialView?.fac ?? null);
  const [components, setComponents] = useState<GridComponent[]>([]);
  const [selectedComponentId, setSelectedComponentId] = useState<string | null>(initialView?.cmp ?? null);
  const [measurementTypes, setMeasurementTypes] = useState<MeasurementTypeInfo[]>([]);
  const [selectedMtype, setSelectedMtype] = useState<string>(initialView?.mt ?? '');

  const [selectedSeriesList, setSelectedSeriesList] = useState<SelectedSeries[]>(initialView?.series ?? []);
  const [timeseriesDataMap, setTimeseriesDataMap] = useState<Record<string, TimeseriesData>>({});

  const [heatmapData, setHeatmapData] = useState<HeatmapData | null>(null);

  // Error tracking
  const [facilitiesError, setFacilitiesError] = useState<string | null>(null);
  const [heatmapError, setHeatmapError] = useState<string | null>(null);
  const [timeseriesErrors, setTimeseriesErrors] = useState<Record<string, string>>({});

  const [loading, setLoading] = useState(false);
  const [facilitiesLoading, setFacilitiesLoading] = useState(false);
  const [componentsLoading, setComponentsLoading] = useState(false);
  const [measurementTypesLoading, setMeasurementTypesLoading] = useState(false);
  const [timeseriesLoadingKeys, setTimeseriesLoadingKeys] = useState<Set<string>>(() => new Set());
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => storedThemeMode());
  const [resolutions, setResolutions] = useState<ResolutionInfo[]>([
    { minutes: 60, label: '1 Stunde' },
    { minutes: 240, label: '4 Stunden' },
    { minutes: 1440, label: '1 Tag' },
  ]);
  // The overview always shows raw, native-resolution data. Aggregation is a
  // deliberate, separate action: the user adds a dedicated aggregated chart
  // via the chart picker — it is never applied to the raw overview.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [analyticsLoading, setAnalyticsLoading] = useState({ heatmap: false });
  // Generic generated-chart state. Replaces the former aggregation-only list:
  // each entry is a fully self-describing DashboardChartConfig rendered by a
  // DynamicChartCard.
  const [dynamicCharts, setDynamicCharts] = useState<DashboardChartConfig[]>(initialView?.charts ?? []);
  const [chartPickerOpen, setChartPickerOpen] = useState(false);

  // Optional views (time series overlay, heatmap, peak demand). None is shown
  // by default; the user adds them explicitly and removes them again.
  const [activePanels, setActivePanels] = useState<Set<string>>(
    () => new Set(initialView?.panels ?? []),
  );
  const hidePanel = useCallback((id: string) => {
    setActivePanels((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);
  const showPanel = useCallback((id: string) => {
    setActivePanels((prev) => new Set(prev).add(id));
  }, []);

  const addDynamicChart = useCallback((templateId: string, config: DynamicChartConfig) => {
    setDynamicCharts((prev) => [
      ...prev,
      { id: `chart-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, templateId, config },
    ]);
  }, []);

  const removeDynamicChart = useCallback((id: string) => {
    setDynamicCharts((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const clearAllDynamicCharts = useCallback(() => {
    setDynamicCharts((prev) => {
      if (prev.length === 0) return prev;
      const confirmed = window.confirm(
        `${prev.length} Diagramm${prev.length === 1 ? '' : 'e'} wirklich entfernen? Das kann nicht rückgängig gemacht werden.`,
      );
      return confirmed ? [] : prev;
    });
  }, []);

  const updateDynamicChartConfig = useCallback((id: string, config: DynamicChartConfig) => {
    setDynamicCharts((prev) => prev.map((chart) => (
      chart.id === id ? { ...chart, config } : chart
    )));
  }, []);

  // Per-section visibility gates: each analytics card only fires its fetch
  // once it scrolls into (or near) the viewport. `rootMargin: 200px` so the
  // request starts a hair before the card is on-screen, hiding the latency.
  const [heatmapRef, heatmapInView] = useInView<HTMLDivElement>();

  const [heatmapSelectionKey, setHeatmapSelectionKey] = useState<string | null>(null);
  const [peakDemandSelectionKey, setPeakDemandSelectionKey] = useState<string | null>(null);
  const [peakDemandPeriod, setPeakDemandPeriod] = useState<PeakDemandPeriod>('month');
  const [selectedPeakIndex, setSelectedPeakIndex] = useState(0);
  // True while the overview is showing a frozen snapshot (from a shared link).
  // Auto-clears once a real fetch happens (e.g. the user changes the range).
  const [snapshotActive, setSnapshotActive] = useState(false);
  // Frozen overview data awaiting injection by the timeseries fetch effect.
  const pendingSnapshotRef = useRef<Record<string, TimeseriesData> | null>(null);

  // The current view as a serialisable snapshot.
  const currentView = useMemo<SharedView>(() => ({
    v: 1,
    fac: selectedFacilityId,
    cmp: selectedComponentId,
    mt: selectedMtype,
    series: selectedSeriesList,
    charts: dynamicCharts,
    panels: [...activePanels],
  }), [selectedFacilityId, selectedComponentId, selectedMtype, selectedSeriesList, dynamicCharts, activePanels]);

  // Persist the view locally so a reload (or recovery after a dropped
  // connection) restores it. localStorage has no length limit, so the view
  // can hold any number of charts. Debounced to avoid thrashing.
  useEffect(() => {
    const t = setTimeout(() => {
      // Persist any meaningful state — including a bare facility/component
      // selection — so a reload restores the picker, not just added charts.
      const hasContent = currentView.series.length > 0
        || currentView.charts.length > 0
        || !!currentView.fac
        || !!currentView.cmp
        || !!currentView.panels?.length;
      if (hasContent) {
        saveLocalView(currentView);
      } else {
        clearLocalView();
      }
    }, 400);
    return () => clearTimeout(t);
  }, [currentView]);

  // Load a shared view (?s=<id>) once on mount. For a snapshot, the frozen
  // overview data is staged in pendingSnapshotRef before the series are set,
  // so the fetch effect injects it instead of querying Oracle.
  useEffect(() => {
    const sid = readShareIdFromUrl();
    if (!sid) return;
    let active = true;
    getShare(sid)
      .then((env) => {
        if (!active) return;
        const view = env.payload?.view as SharedView | undefined;
        if (!view) { setShareSettled(true); return; }
        // Tell the cascade effects which child selections to keep (instead of
        // resetting to defaults) when the parent facility/component is applied.
        restoreRef.current = { fac: view.fac ?? null, cmp: view.cmp ?? null, mt: view.mt ?? '' };
        if (env.kind === 'snapshot') {
          const ts = (env.payload?.data as { timeseries?: Record<string, TimeseriesData> } | undefined)?.timeseries;
          if (ts) { pendingSnapshotRef.current = ts; setSnapshotActive(true); }
        }
        setShareSettled(true);
        setSelectedFacilityId(view.fac ?? null);
        setSelectedComponentId(view.cmp ?? null);
        setSelectedMtype(view.mt ?? '');
        setDynamicCharts(view.charts ?? []);
        setActivePanels(new Set(view.panels ?? []));
        // Set series last: this triggers the fetch effect, which consumes
        // pendingSnapshotRef set above.
        setSelectedSeriesList(view.series ?? []);
      })
      .catch(() => { if (active) setShareSettled(true); /* invalid/expired share → empty dashboard */ });
    return () => { active = false; };
  }, []);

  // Track the previous component key so we can distinguish a component change
  // (clear stale data) from a date-range change (keep old data visible while
  // re-fetching — optimistic display).
  const timeseriesScopeByKeyRef = useRef<Record<string, string>>({});

  // -- Geo-map state ------------------------------------------------------
  // Scrollytelling: map is sticky full-viewport; charts scroll up over it
  // and the map dims progressively as the chart cards take focus.
  const [gridTopology, setGridTopology] = useState<MockTopology>(() => ENABLE_GRID_MAP ? fallbackGridTopology() : { stations: [], circuits: [], transformers: [] });
  const [, setGridLoading] = useState(ENABLE_GRID_MAP);
  // Defer mounting the MapLibre map (the single largest JS chunk, ~273 KB gz)
  // until the browser is idle, so the dashboard shell, controls, and charts
  // paint first. A placeholder holds the layout until then.
  const [mapDeferReady, setMapDeferReady] = useState(false);
  const [, setGridError] = useState<string | null>(null);
  const [, setGridWarnings] = useState<string[]>([]);
  const [mapWheelMode, setMapWheelMode] = useState<'scroll' | 'zoom'>('scroll');
  const [mapLayerMode, setMapLayerMode] = useState<MapLayerMode>('grid');
  const [selectedStationUuid, setSelectedStationUuid] = useState<string | null>(null);
  const [, setGeoMatchResult] = useState<MatchResult | null>(null);
  const [activeSectionId, setActiveSectionId] = useState<string>('map-selection');
  // Sections of the summary currently on screen (reported by the summary itself).
  const [summarySectionList, setSummarySectionList] = useState<SummarySection[]>([]);
  // One navigation list: the sections of the summary, then the views the user added, then the custom charts.
  const navItems = useMemo(() => {
    const summary = summarySectionList.length > 0
      ? summarySectionList.map((section) => ({ id: section.id, label: section.label, count: section.count, group: 'summary' as const }))
      : [{ id: 'map-selection', label: 'Zusammenfassung', count: undefined, group: 'summary' as const }];
    const views = NAV_SECTIONS
      .filter((section) => section.id !== 'map-selection' && (section.panel === null || activePanels.has(section.panel)))
      .map((section) => ({ id: section.id, label: section.label, count: undefined, group: 'views' as const }));
    return [...summary, ...views];
  }, [summarySectionList, activePanels]);
  useEffect(() => {
    if (!ENABLE_GRID_MAP) return;
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    });
    let idleId: number;
    let timeoutId: ReturnType<typeof setTimeout>;
    if (ric.requestIdleCallback) {
      idleId = ric.requestIdleCallback(() => setMapDeferReady(true), { timeout: 2000 });
    } else {
      timeoutId = setTimeout(() => setMapDeferReady(true), 300);
    }
    return () => {
      if (ric.cancelIdleCallback && idleId != null) ric.cancelIdleCallback(idleId);
      if (timeoutId != null) clearTimeout(timeoutId);
    };
  }, []);

  // Refs used by the scroll listener that drives the CSS dim progression.
  const tabScrollRef = useRef<HTMLDivElement>(null);
  const mapHeroRef = useRef<HTMLElement>(null);
  const navDockRef = useRef<HTMLElement>(null);


  // GridMapLibre fires this once it finishes loading + validating topology.
  // We adapt the GridTopologyCompat → MockTopology shape so all downstream
  // state (stationMatchMap, KPI pills, handleSelectStation) keeps working
  // without further changes.
  const handleTopologyReady = useCallback((compat: GridTopologyCompat) => {
    const adapted: MockTopology = {
      stations: compat.stations.map((s) => ({
        uuid:           s.uuid,
        langname:       s.langname,
        identifierKurz: s.identifierKurz,
        typ:            'UW',
        spannungsebenen: s.spannungsebenen,
        status:         s.status,
        planung:        s.planung,
        lat:            s.lat,
        lon:            s.lon,
      })),
      circuits: compat.circuits.map((c) => ({
        uuid:           c.uuid,
        langname:       c.uuid,
        identifierKurz: c.uuid,
        typ:            'LEITUNG',
        spannungsebene: '',
        stationen:      c.stationen,
        planung:        false,
      })),
      transformers: [],
      warnings:     compat.warnings,
    };
    setGridTopology(adapted);
    setGridWarnings(compat.warnings ?? []);
    setGridLoading(false);
    setGridError(null);
  }, []);

  const handleMapLoadError = useCallback((msg: string) => {
    setGridError(msg);
    setGridLoading(false);
    logError('Dashboard', 'GridMapLibre: Kartendaten konnten nicht geladen werden', msg);
  }, []);

  useEffect(() => {
    const container = tabScrollRef.current;
    if (!container) return;

    let rafId = 0;
    const updateActiveSection = () => {
      rafId = 0;
      const containerTop = container.getBoundingClientRect().top;
      const focusScroll = container.scrollTop + container.clientHeight * 0.36;
      // Reading order: summary first (with its sub-sections), then the optional views.
      const ids = ['map-selection', ...navItems.map((item) => item.id).filter((id) => id !== 'map-selection')];
      let nextId = navItems[0]?.id ?? 'map-selection';
      ids.forEach((id) => {
        const element = document.getElementById(id);
        if (!element) return;
        const sectionTop = element.getBoundingClientRect().top - containerTop + container.scrollTop;
        if (sectionTop <= focusScroll) nextId = id;
      });

      setActiveSectionId((current) => (current === nextId ? current : nextId));
    };

    const onScroll = () => {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(updateActiveSection);
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    updateActiveSection();

    return () => {
      container.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (rafId !== 0) cancelAnimationFrame(rafId);
    };
  }, [navItems]);

  // -- Scrollytelling: dim the sticky map as the user scrolls into the
  //    chart overlay. This updates a CSS variable directly so Leaflet is not
  //    re-rendered on every scroll frame.
  useEffect(() => {
    if (!ENABLE_GRID_MAP) {
      mapHeroRef.current?.style.setProperty('--scroll-dim', '0');
      return;
    }
    const container = tabScrollRef.current;
    if (!container) return;

    let rafId = 0;
    const compute = () => {
      rafId = 0;
      const scrollTop = container.scrollTop;
      const vh = container.clientHeight;
      // Dimming ramps up between 10% and 60% of viewport-scrolled.
      // Beyond 60%, the map is fully dimmed.
      const start = vh * 0.10;
      const end = vh * 0.60;
      const raw = (scrollTop - start) / (end - start);
      const progress = Math.max(0, Math.min(1, raw));
      mapHeroRef.current?.style.setProperty('--scroll-dim', progress.toFixed(3));
    };
    const onScroll = () => {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(compute);
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    compute();
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (rafId !== 0) cancelAnimationFrame(rafId);
    };
  }, []);

  const lastFacilityRefreshRef = useRef(0);
  const refreshFacilities = useCallback(() => {
    setFacilitiesLoading(true);
    return getFacilities()
      .then((data) => {
        setFacilities(data);
        setFacilitiesError(null);
        lastFacilityRefreshRef.current = Date.now();
      })
      .catch((err) => {
        const msg = extractError(err);
        setFacilities([]);
        setFacilitiesError(msg);
        logError('Dashboard', 'Anlagen konnten nicht geladen werden', msg);
      })
      .finally(() => setFacilitiesLoading(false));
  }, []);

  useEffect(() => { refreshFacilities(); }, [refreshFacilities]);


  useEffect(() => {
    return applyGridThemeMode(themeMode);
  }, [themeMode]);

  // Re-fetch facilities when the user returns to the tab — catches new
  // facilities added in another client. Throttled to once per 10 s.
  useEffect(() => {
    const onFocus = () => {
      if (Date.now() - lastFacilityRefreshRef.current < 10_000) return;
      refreshFacilities();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshFacilities]);

  useEffect(() => {
    getResolutions()
      .then((data) => { if (Array.isArray(data)) setResolutions(data); })
      .catch(() => { /* keep the hard-coded fallback */ });
  }, []);

  // Auto-select first facility once facilities are loaded (helps UX and makes
  // it obvious data is present). Wait for a pending share to settle first so it
  // doesn't claim the picker before the shared facility is applied.
  useEffect(() => {
    if (!shareSettled) return;
    if (facilities.length > 0 && !selectedFacilityId) {
      setSelectedFacilityId(facilities[0].id);
    }
  }, [facilities, selectedFacilityId, shareSettled]);

  // No dashboard date filter: every signal loads its complete simulation.
  const startIso = undefined;
  const endIso = undefined;

  useEffect(() => {
    if (!selectedFacilityId) {
      setComponents([]);
      setSelectedComponentId(null);
      setComponentsLoading(false);
      return;
    }
    let active = true;
    setComponentsLoading(true);
    // Keep a restored component (and its measurement) on the first pass after a
    // share/reload; only reset to defaults for a genuine facility change.
    const restoreCmp = restoreRef.current?.fac === selectedFacilityId
      ? restoreRef.current?.cmp ?? null
      : null;
    if (!restoreCmp) {
      setSelectedComponentId(null);
      setMeasurementTypes([]);
      setMeasurementTypesLoading(false);
      setSelectedMtype('');
    }
    getComponentsByFacility(selectedFacilityId)
      .then((data) => {
        if (!active) return;
        setComponents(data);
        if (restoreCmp) {
          if (data.some((c) => c.id === restoreCmp)) {
            setSelectedComponentId(restoreCmp);
          } else {
            // Restored component no longer exists — drop the restore.
            setSelectedComponentId(null);
            restoreRef.current = null;
          }
        }
      })
      .catch((err) => {
        if (!active) return;
        setComponents([]);
        logError('Dashboard', 'Betriebsmittel konnten nicht geladen werden', extractError(err));
      })
      .finally(() => { if (active) setComponentsLoading(false); });
    return () => { active = false; };
  }, [selectedFacilityId]);

  useEffect(() => {
    if (!selectedComponentId) {
      setMeasurementTypes([]);
      setSelectedMtype('');
      setMeasurementTypesLoading(false);
      restoreRef.current = null;
      return;
    }
    let active = true;
    setMeasurementTypesLoading(true);
    // Keep a restored measurement on the first pass; otherwise default to first.
    const restoreMt = restoreRef.current?.cmp === selectedComponentId
      ? restoreRef.current?.mt ?? ''
      : '';
    if (!restoreMt) setSelectedMtype('');
    getMeasurementTypes(selectedComponentId)
      .then((data) => {
        if (!active) return;
        setMeasurementTypes(data);
        if (restoreMt && data.some((t) => t.type === restoreMt)) {
          setSelectedMtype(restoreMt);
        } else if (data.length > 0) {
          setSelectedMtype(data[0].type);
        }
        // Restore fully consumed once the measurement is resolved.
        restoreRef.current = null;
      })
      .catch((err) => {
        if (!active) return;
        setMeasurementTypes([]);
        logError('Dashboard', 'Messgrößen konnten nicht geladen werden', extractError(err));
      })
      .finally(() => { if (active) setMeasurementTypesLoading(false); });
    return () => { active = false; };
  }, [selectedComponentId]);

  // -- Geo-map: station selection + fuzzy facility matching --------------
  const handleSelectStation = useCallback(
    (uuid: string) => {
      if (!ENABLE_GRID_MAP) return;
      setSelectedStationUuid(uuid);
      const station = gridTopology.stations.find((s) => s.uuid === uuid) as MockStation | undefined;
      if (!station) return;

      if (facilities.length > 0) {
        const directFacility = facilities.find((facility) => facility.id === station.uuid);
        if (directFacility) {
          setGeoMatchResult({
            facility: directFacility,
            score: 1,
            confidence: 'high',
            matchedTokens: [station.identifierKurz, station.langname],
          });
          setSelectedFacilityId(directFacility.id);
          return;
        }
        const result = matchStation(station, facilities);
        setGeoMatchResult(result);
        if (result && result.confidence === 'high') {
          setSelectedFacilityId(result.facility.id);
        }
      } else {
        // Facilities not yet loaded — match will fire on next facilities load.
        setGeoMatchResult(null);
      }

    },
    [facilities, gridTopology],
  );

  const clearMapSelection = useCallback(() => {
    setSelectedStationUuid(null);
    setGeoMatchResult(null);
  }, []);

  // Re-run match whenever facilities load (covers the case where the user
  // clicked a station before facilities were available).
  useEffect(() => {
    if (!ENABLE_GRID_MAP) return;
    if (!selectedStationUuid || facilities.length === 0) return;
    const station = gridTopology.stations.find((s) => s.uuid === selectedStationUuid) as MockStation | undefined;
    if (!station) return;
    const directFacility = facilities.find((facility) => facility.id === station.uuid);
    if (directFacility) {
      setGeoMatchResult({
        facility: directFacility,
        score: 1,
        confidence: 'high',
        matchedTokens: [station.identifierKurz, station.langname],
      });
      setSelectedFacilityId(directFacility.id);
      return;
    }
    const result = matchStation(station, facilities);
    setGeoMatchResult(result);
    if (result && result.confidence === 'high') {
      setSelectedFacilityId(result.facility.id);
    }
  }, [facilities, gridTopology, selectedStationUuid]);

  const addSeries = useCallback(() => {
    if (!selectedComponentId || !selectedMtype || !selectedFacilityId) return;
    const comp = components.find((c) => c.id === selectedComponentId);
    const fac = facilities.find((f) => f.id === selectedFacilityId);
    if (!comp || !fac) return;
    const key = `${selectedComponentId}-${selectedMtype}`;
    if (selectedSeriesList.some((s) => s.key === key)) return;
    setSelectedSeriesList((prev) => [
      ...prev,
      { key, facilityName: fac.name, facilityId: fac.id, componentId: selectedComponentId, componentName: comp.name, measurementType: selectedMtype },
    ]);
  }, [selectedComponentId, selectedMtype, selectedFacilityId, components, facilities, selectedSeriesList]);

  const removeSeries = useCallback((key: string) => {
    setSelectedSeriesList((prev) => prev.filter((s) => s.key !== key));
    setTimeseriesDataMap((prev) => { const next = { ...prev }; delete next[key]; return next; });
    setTimeseriesErrors((prev) => { const next = { ...prev }; delete next[key]; return next; });
    setTimeseriesLoadingKeys((prev) => { const next = new Set(prev); next.delete(key); return next; });
    delete timeseriesScopeByKeyRef.current[key];
  }, []);

  useEffect(() => {
    const selectedKeys = new Set(selectedSeriesList.map((s) => s.key));
    Object.keys(timeseriesScopeByKeyRef.current).forEach((key) => {
      if (!selectedKeys.has(key)) delete timeseriesScopeByKeyRef.current[key];
    });

    if (selectedSeriesList.length === 0) {
      setTimeseriesDataMap({});
      setTimeseriesErrors({});
      setTimeseriesLoadingKeys(new Set());
      setLoading(false);
      timeseriesScopeByKeyRef.current = {};
      return;
    }

    setTimeseriesDataMap((prev) => {
      const next: Record<string, TimeseriesData> = {};
      selectedSeriesList.forEach((series) => {
        const data = prev[series.key];
        if (data) next[series.key] = data;
      });
      return next;
    });
    setTimeseriesErrors((prev) => {
      const next: Record<string, string> = {};
      selectedSeriesList.forEach((series) => {
        const error = prev[series.key];
        if (error) next[series.key] = error;
      });
      return next;
    });

    const scopeKey = `${startIso}|${endIso}|${refreshNonce}`;

    // Inject a frozen snapshot (from a shared link): seed the data and mark
    // those keys as already current for this scope so they are NOT re-fetched.
    // If the user later changes the range, scopeKey changes and they go live.
    if (pendingSnapshotRef.current) {
      const snap = pendingSnapshotRef.current;
      pendingSnapshotRef.current = null;
      setTimeseriesDataMap((prev) => ({ ...prev, ...snap }));
      Object.keys(snap).forEach((key) => { timeseriesScopeByKeyRef.current[key] = scopeKey; });
    }

    const seriesToFetch = selectedSeriesList.filter(
      (series) => timeseriesScopeByKeyRef.current[series.key] !== scopeKey,
    );

    if (seriesToFetch.length === 0) {
      setTimeseriesLoadingKeys(new Set());
      setLoading(false);
      return;
    }

    // A real fetch means we are no longer showing the frozen snapshot.
    if (snapshotActive) setSnapshotActive(false);

    const controller = new AbortController();
    setLoading(true);
    setTimeseriesLoadingKeys((prev) => {
      const next = new Set(prev);
      seriesToFetch.forEach((series) => next.add(series.key));
      return next;
    });
    setTimeseriesErrors((prev) => {
      const next = { ...prev };
      seriesToFetch.forEach((series) => delete next[series.key]);
      return next;
    });
    // Debounce so dragging the date picker or rapidly clicking range presets
    // only fires one request once the user settles.
    const timer = setTimeout(() => {
      // The overview is always raw (native resolution). No silent aggregation.
      // Cap concurrency so a wide multi-series fetch doesn't slam Oracle with
      // N heavy reads at once. 2 in flight keeps the pool happy and lets
      // results render progressively.
      const CONCURRENCY = 2;
      const queue = [...seriesToFetch];
      const runNext = async (): Promise<void> => {
        const s = queue.shift();
        if (!s || controller.signal.aborted) return;
        try {
          const data = await getTimeseries(
            s.componentId, s.measurementType, startIso, endIso, undefined, undefined, controller.signal,
          );
          if (controller.signal.aborted) return;
          timeseriesScopeByKeyRef.current[s.key] = scopeKey;
          setTimeseriesDataMap((prev) => ({ ...prev, [s.key]: data }));
          setTimeseriesErrors((prev) => {
            const next = { ...prev };
            delete next[s.key];
            return next;
          });
        } catch (err) {
          if (controller.signal.aborted) return;
          // Raw range too large: never auto-aggregate. Guide the user to
          // narrow the range or export, or add a dedicated aggregated chart.
          const msg =
            err instanceof RawRangeTooLargeError
              ? `Zeitraum zu groß für Rohdaten${err.estimatedPoints ? ` (~${err.estimatedPoints.toLocaleString()} Punkte)` : ''}. Simulation kürzen, exportieren oder ein aggregiertes Diagramm hinzufügen.`
              : extractError(err);
          setTimeseriesErrors((prev) => ({ ...prev, [s.key]: msg }));
        } finally {
          if (!controller.signal.aborted) {
            setTimeseriesLoadingKeys((prev) => {
              const next = new Set(prev);
              next.delete(s.key);
              return next;
            });
          }
        }
        return runNext();
      };
      Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => runNext())
      ).then(() => {
        if (controller.signal.aborted) return;
        setTimeseriesDataMap((prev) => {
          const next: Record<string, TimeseriesData> = {};
          selectedSeriesList.forEach((series) => {
            const data = prev[series.key];
            if (data) next[series.key] = data;
          });
          return next;
        });
        setTimeseriesErrors((prev) => {
          const next: Record<string, string> = {};
          selectedSeriesList.forEach((series) => {
            const error = prev[series.key];
            if (error) next[series.key] = error;
          });
          return next;
        });
        setLoading(false);
        setTimeseriesLoadingKeys((prev) => {
          const next = new Set(prev);
          seriesToFetch.forEach((series) => next.delete(series.key));
          return next;
        });
      });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
      setTimeseriesLoadingKeys(new Set());
      setLoading(false);
    };
  }, [selectedSeriesList, startIso, endIso, refreshNonce]);

  const seriesDataList = useMemo(
    () => selectedSeriesList.flatMap((s) => {
      const data = timeseriesDataMap[s.key];
      return data ? [{ ...data, component_name: `${s.facilityName} / ${s.componentName}` }] : [];
    }),
    [selectedSeriesList, timeseriesDataMap],
  );

  // Geo-map derived: the station object and matching facility for the context bar.
  const selectedStation: MockStation | null = useMemo(
    () => (ENABLE_GRID_MAP && selectedStationUuid ? (gridTopology.stations.find((s) => s.uuid === selectedStationUuid) ?? null) : null),
    [selectedStationUuid, gridTopology],
  );
  const selectedFacilityForBar = useMemo(
    () => (selectedFacilityId ? (facilities.find((f) => f.id === selectedFacilityId) ?? null) : null),
    [selectedFacilityId, facilities],
  );

  // Pre-compute fuzzy matches for ALL mock stations so the map can colour
  // markers by confidence before the user clicks anything.
  const stationMatchMap = useMemo((): Map<string, MatchResult | null> => {
    if (!ENABLE_GRID_MAP) return new Map();
    if (facilities.length === 0) return new Map();
    return matchAllStations(gridTopology.stations, facilities);
  }, [facilities, gridTopology]);


  const heatmapCandidates = useMemo(
    () => selectedSeriesList,
    [selectedSeriesList],
  );
  const heatmapSeries = useMemo(
    () => (heatmapSelectionKey ? selectedSeriesList.find((series) => series.key === heatmapSelectionKey) ?? null : null),
    [heatmapSelectionKey, selectedSeriesList],
  );
  const peakDemandCandidates = useMemo(
    () => selectedSeriesList.filter((series) => series.measurementType === 'P'),
    [selectedSeriesList],
  );
  const peakDemandSeries = useMemo(
    () => (peakDemandSelectionKey ? peakDemandCandidates.find((series) => series.key === peakDemandSelectionKey) ?? null : null),
    [peakDemandCandidates, peakDemandSelectionKey],
  );
  useEffect(() => {
    if (heatmapCandidates.length === 0) {
      if (heatmapSelectionKey !== null) setHeatmapSelectionKey(null);
      setHeatmapData(null);
      setHeatmapError(null);
      return;
    }
    const hasSelection = heatmapSelectionKey && heatmapCandidates.some((series) => series.key === heatmapSelectionKey);
    if (!hasSelection) {
      setHeatmapSelectionKey(heatmapCandidates[0].key);
      setHeatmapData(null);
      setHeatmapError(null);
    }
  }, [heatmapCandidates, heatmapSelectionKey]);
  useEffect(() => {
    if (peakDemandCandidates.length === 0) {
      if (peakDemandSelectionKey !== null) setPeakDemandSelectionKey(null);
      return;
    }
    const hasSelection = peakDemandSelectionKey && peakDemandCandidates.some((series) => series.key === peakDemandSelectionKey);
    if (!hasSelection) {
      setPeakDemandSelectionKey(peakDemandCandidates[0].key);
    }
  }, [peakDemandCandidates, peakDemandSelectionKey]);
  const peakDemandRowsByPeriod = useMemo(
    () => buildPeakDemandRows(peakDemandSeries ? [peakDemandSeries] : [], timeseriesDataMap),
    [peakDemandSeries, timeseriesDataMap],
  );
  const peakDemandRows = peakDemandRowsByPeriod[peakDemandPeriod];
  const selectedPeakDemand = peakDemandRows[Math.min(selectedPeakIndex, Math.max(peakDemandRows.length - 1, 0))] ?? null;
  const topPeakDemandRows = useMemo(
    () => [...peakDemandRows].sort((a, b) => b.value - a.value).slice(0, 5),
    [peakDemandRows],
  );

  useEffect(() => {
    if (peakDemandRows.length === 0) {
      setSelectedPeakIndex(0);
      return;
    }
    const maxIndex = peakDemandRows.reduce(
      (best, row, index) => (row.value > peakDemandRows[best].value ? index : best),
      0,
    );
    setSelectedPeakIndex(maxIndex);
  }, [peakDemandRows]);

  useEffect(() => {
    if (!heatmapSeries || !heatmapInView) return;
    setHeatmapError(null);
    setHeatmapData(null);
    setAnalyticsLoading((p) => ({ ...p, heatmap: true }));
    getHeatmap(heatmapSeries.componentId, heatmapSeries.measurementType, startIso, endIso)
      .then((d) => { setHeatmapData(d); setHeatmapError(null); })
      .catch((err) => { setHeatmapData(null); setHeatmapError(extractError(err)); })
      .finally(() => setAnalyticsLoading((p) => ({ ...p, heatmap: false })));
  }, [heatmapSeries, heatmapInView, startIso, endIso, refreshNonce]);

  const timeseriesRefreshing = loading || timeseriesLoadingKeys.size > 0;
  const selectedPeakDemandData = peakDemandSeries ? timeseriesDataMap[peakDemandSeries.key] : null;
  const peakDemandLoading = !!peakDemandSeries && (timeseriesLoadingKeys.has(peakDemandSeries.key) || timeseriesRefreshing || !selectedPeakDemandData);

  const resetNavDock = useCallback(() => {
    navDockRef.current?.querySelectorAll<HTMLElement>('.one-page-nav__item').forEach((item) => {
      item.style.setProperty('--dock-scale', '1');
      item.style.setProperty('--dock-lift', '0px');
      item.style.setProperty('--dock-glow', '0');
    });
  }, []);

  const handleNavDockPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    const nav = navDockRef.current;
    if (!nav) return;
    const items = Array.from(nav.querySelectorAll<HTMLElement>('.one-page-nav__item'));
    const pointerX = event.clientX;
    const radius = 132;

    items.forEach((item) => {
      const rect = item.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const influence = Math.max(0, 1 - Math.abs(pointerX - centerX) / radius);
      const eased = influence * influence * (3 - 2 * influence);
      item.style.setProperty('--dock-scale', (1 + eased * 0.34).toFixed(3));
      item.style.setProperty('--dock-lift', `${Math.round(eased * -5)}px`);
      item.style.setProperty('--dock-glow', eased.toFixed(3));
    });
  }, []);

  // Native `<a href="#id">` anchor-jump (+ CSS scroll-behavior: smooth) is
  // unreliable here: #map-selection (the "Karte" target) is `position:
  // sticky`, so its bounding rect changes non-monotonically as it re-pins
  // mid-scroll. That fools the browser's "has the target arrived" check and
  // the animation can stop early — landing on whatever section happened to
  // be in view at that moment instead of the map. Computing the target
  // scrollTop ourselves and animating via Element.scrollTo() sidesteps it:
  // that's a scroll to a fixed number, not "track this moving element".
  const scrollToSection = useCallback((id: string) => {
    const container = tabScrollRef.current;
    if (!container) return;
    if (id === 'map-selection' || id === summarySectionList[0]?.id) {
      // Sticky map + rising chart overlay can make smooth scrolling settle in
      // the chart zone. Jumping to the real top keeps "Karte" deterministic.
      container.scrollTo({ top: 0, behavior: 'auto' });
      setActiveSectionId(id);
      return;
    }
    // A collapsed summary card opens first, so the target has its final height.
    openSection(id);
    const targetTop = () => {
      const target = document.getElementById(id);
      return target
        ? target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 8
        : null;
    };
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const top = targetTop();
      if (top !== null) container.scrollTo({ top, behavior: 'smooth' });
      // Charts above the target may finish loading while the scroll runs and move it; correct once afterwards.
      window.setTimeout(() => {
        const settled = targetTop();
        if (settled !== null && Math.abs(settled - container.scrollTop) > 12) container.scrollTo({ top: settled, behavior: 'smooth' });
      }, 700);
    }));
  }, [summarySectionList]);

  return (
    <>
    <div className="grid-theme-scope dashboard-shell h-screen flex flex-col bg-[var(--grid-bg)] text-[var(--grid-text)] overflow-hidden">
      <header className="sticky top-0 z-[900] grid grid-cols-1 items-center gap-3 bg-[var(--grid-header)] border-b border-[var(--grid-border)] px-4 py-3 shrink-0 xl:grid-cols-[minmax(180px,auto)_minmax(0,1fr)_auto]">
        <div className="flex min-w-0 items-center gap-2 xl:justify-self-start">
          <DatabasePicker />
          <h1 className="truncate text-base font-bold tracking-tight text-[var(--grid-text)]">{uiConfig.brand.appName}</h1>
        </div>

        <nav
          ref={navDockRef}
          aria-label="Analyseabschnitte"
          className={`one-page-nav${navItems.length > 7 ? ' one-page-nav--dense' : ''}`}
          onPointerMove={handleNavDockPointerMove}
          onPointerLeave={resetNavDock}
          onBlur={resetNavDock}
        >
          {navItems.map((item, index) => (
            <Fragment key={item.id}>
              {index > 0 && item.group !== navItems[index - 1].group && <span className="one-page-nav__sep" aria-hidden />}
              <a
                className="one-page-nav__item"
                href={`#${item.id}`}
                onClick={(e) => { e.preventDefault(); scrollToSection(item.id); }}
                aria-current={activeSectionId === item.id ? 'page' : undefined}
              >
                {item.label}
                {item.count !== undefined && <span className="one-page-nav__count">{item.count}</span>}
              </a>
            </Fragment>
          ))}
        </nav>

        <div className="flex min-w-0 flex-wrap items-center justify-end gap-3 xl:justify-self-end">
          <CinematicThemeSwitch value={themeMode} onChange={setThemeMode} />

        </div>
      </header>


      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <details open className="selection-dock shrink-0 border-b border-gray-700 bg-gray-800/30 p-3">
            <summary className="dashboard-filter-toggle">Filter und Messreihen</summary>
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex items-start gap-1">
                <SearchableDropdown
                  label="Szenario"
                  items={Array.isArray(facilities) ? facilities : []}
                  idOf={(f) => f.id}
                  labelOf={(f) => `${f.name}${f.spannungsebene ? ` · ${f.spannungsebene}` : ''}`}
                  value={selectedFacilityId}
                  onChange={setSelectedFacilityId}
                  placeholder="- Szenario -"
                  emptyHint="Noch keine berechneten Szenarien"
                  loading={facilitiesLoading}
                  loadingLabel="Szenarien werden geladen"
                  className="min-w-[200px]"
                />
                <div className="flex flex-col">
                  <span aria-hidden className="mb-1 block h-4 text-xs">&nbsp;</span>
                  <button
                    type="button"
                    onClick={() => {
                      clearCache();
                      refreshFacilities();
                      setRefreshNonce((n) => n + 1);
                    }}
                    title="Szenarien + Diagramme neu laden"
                    className={`flex h-10 w-10 items-center justify-center rounded border border-gray-600 bg-gray-700 text-sm text-gray-400 transition-colors hover:bg-gray-600 hover:text-white ${facilitiesLoading ? 'animate-pulse' : ''}`}
                  >
                    ↻
                  </button>
                </div>
              </div>
              <SearchableDropdown
                label="Betriebsmittel"
                items={components}
                idOf={(c) => c.id}
                labelOf={(c) => `${c.name}${c.spannungsebene ? ` (${c.spannungsebene})` : ''}`}
                searchOf={(c) => [c.name, c.id, c.spannungsebene ?? ''].join(' ')}
                value={selectedComponentId}
                onChange={setSelectedComponentId}
                placeholder="- Betriebsmittel - (Name, ID, kV-Ebene)"
                  emptyHint="Keine Betriebsmittel"
                  disabled={!selectedFacilityId}
                  loading={componentsLoading}
                  loadingLabel="Betriebsmittel werden geladen"
                  className="min-w-[240px]"
                />
              <SearchableDropdown
                label="Messgröße"
                items={measurementTypes}
                idOf={(mt) => mt.type}
                labelOf={(mt) => `${MTYPE_LABELS[mt.type] || mt.type} (${mt.unit})`}
                value={selectedMtype || null}
                onChange={(v) => setSelectedMtype(v ?? '')}
                placeholder="- Messgröße -"
                emptyHint="Keine Messgrößen"
                disabled={!selectedComponentId}
                loading={measurementTypesLoading}
                loadingLabel="Messgrößen werden geladen"
                className="min-w-[180px]"
              />
              <div className="flex flex-col">
                <span aria-hidden className="mb-1 block h-4 text-xs">&nbsp;</span>
                <AnimatedButton
                  variant="primary"
                  size="md"
                  onClick={addSeries}
                  disabled={!selectedComponentId || !selectedMtype}
                  icon={<span aria-hidden>+</span>}
                >
                  Hinzufügen
                </AnimatedButton>
              </div>

            </div>

            {selectedSeriesList.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-gray-700">
                {selectedSeriesList.map((s) => (
                  <span
                    key={s.key}
                    className={`relative inline-flex items-center gap-1 overflow-hidden bg-gray-700 border text-xs text-gray-200 px-2 py-0.5 rounded-full ${
                      timeseriesLoadingKeys.has(s.key) ? 'border-cyan-500/70' : 'border-gray-600'
                    }`}
                    aria-busy={timeseriesLoadingKeys.has(s.key)}
                  >
                    <span className="text-gray-400">{s.facilityName}/</span>
                    {s.componentName} - {MTYPE_LABELS[s.measurementType]?.split(' ')[0] || s.measurementType}
                    {timeseriesLoadingKeys.has(s.key) && (
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-cyan-300/40 border-t-cyan-300 animate-spin" />
                    )}
                    <button onClick={() => removeSeries(s.key)} className="text-gray-400 hover:text-red-400 ml-0.5 font-bold">x</button>
                    {timeseriesLoadingKeys.has(s.key) && (
                      <span className="absolute inset-x-0 bottom-0 h-0.5 bg-gray-900/60">
                        <span className="block h-full w-1/2 bg-gradient-to-r from-cyan-500 via-blue-400 to-cyan-500 animate-shimmer" />
                      </span>
                    )}
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setSelectedSeriesList([]);
                    setTimeseriesDataMap({});
                    setTimeseriesErrors({});
                    setTimeseriesLoadingKeys(new Set());
                    timeseriesScopeByKeyRef.current = {};
                  }}
                  className="text-xs text-gray-500 hover:text-red-400 px-1"
                >
                  Alle x
                </button>
              </div>
            )}

          </details>

          <div ref={tabScrollRef} className="flex-1 overflow-y-auto">
            <section id="map-selection" className="p-4">
              <OutageManagement onResultsChanged={() => { clearCache(); refreshFacilities(); setRefreshNonce((n) => n + 1); }} />
              <AcrossScenarios refreshKey={refreshNonce} onSectionsChange={setSummarySectionList} />
            </section>
              <div>

	                {ENABLE_GRID_MAP && (
	                  <section
	                    ref={mapHeroRef}
	                    id="map-selection"
	                    className="map-hero"
	                    aria-label="Geografische Übersicht — Stationen und Stromkreise"
	                  >
                    <ErrorBoundary label="Karte / Grid-Topologie">
                      <Suspense fallback={<ChartFallback height={400} />}>
                        {mapDeferReady ? (
                          <GridMapLibre
                            theme={
                              mapLayerMode === 'satellite'
                                ? 'satellite'
                                : themeMode === 'light'
                                  ? 'light'
                                  : 'dark'
                            }
                            selectedStationUuid={selectedStationUuid}
                            matchedStationUuids={
                              stationMatchMap.size > 0
                                ? new Set(stationMatchMap.keys())
                                : undefined
                            }
                            scrollWheelZoom={mapWheelMode === 'zoom'}
                            onSelectStation={handleSelectStation}
                            onTopologyReady={handleTopologyReady}
                            onLoadError={handleMapLoadError}
                            style={{ height: '100%' }}
                          />
                        ) : (
                          <ChartFallback height={400} />
                        )}
                      </Suspense>
                    </ErrorBoundary>

                    <div className="map-mode-toolbar" aria-label="Kartenmodus">
                      <div className="map-mode-group" aria-label="Scroll- oder Zoommodus">
                        {[
                          { id: 'scroll' as const, label: 'Scroll' },
                          { id: 'zoom' as const, label: 'Zoom' },
                        ].map((option) => (
                          <button
                            key={option.id}
                            type="button"
                            onClick={() => setMapWheelMode(option.id)}
                            aria-pressed={mapWheelMode === option.id}
                            title={option.id === 'scroll'
                              ? 'Mausrad scrollt zur Analyse weiter; zoomen weiter über +/- und Drag/Pan.'
                              : 'Mausrad zoomt die Karte; zum Scrollen außerhalb der Karte bewegen.'}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                      <div className="map-mode-group" aria-label="Kartenlayer">
                        {MAP_LAYER_OPTIONS.map((option) => (
                          <button
                            key={option.id}
                            type="button"
                            onClick={() => setMapLayerMode(option.id)}
                            aria-pressed={mapLayerMode === option.id}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {selectedStation ? (
                      <div className="map-kpi-overlay">
                        <MapKpiPill
                          label="Station"
                          value={selectedStation.langname}
                          onClear={clearMapSelection}
                        />
                        <MapKpiPill
                          label="Spannung"
                          value={selectedStation.spannungsebenen.join(' / ')}
                          unit="kV"
                        />
                        <MapKpiPill
                          label="Stromkreise"
                          value={String(
                            gridTopology.circuits.filter((c) =>
                              c.stationen.includes(selectedStation.uuid),
                            ).length,
                          )}
                        />
                        {selectedFacilityForBar && (
                          <MapKpiPill label="Szenario" value={selectedFacilityForBar.name} highlight />
                        )}
                      </div>
                    ) : (
                      <div className="map-idle-hint">
                        Klicke eine Station, um die Zeitreihe zu laden
                      </div>
                    )}

                    <div className="map-scroll-hint" aria-hidden>
                      <span>Scroll für Zeitreihen</span>
                      <span className="map-scroll-hint-arrow">↓</span>
                    </div>
                  </section>
                )}

                {/* -- Charts overlay: rises up over the sticky map ------- */}
                <section
                  className={ENABLE_GRID_MAP ? 'charts-overlay' : 'charts-overlay charts-overlay--no-map'}
                  aria-label="Zeitreihen-Diagramme"
                >
                  {facilitiesError && (
                    <div className="mx-4 mb-3 flex items-start gap-3 py-3 px-4 bg-red-900/20 rounded border border-red-800/40">
                      <span className="text-red-400 text-xl shrink-0">⚠</span>
                      <div>
                        <div className="text-sm text-red-300 font-medium">Anlagen konnten nicht geladen werden</div>
                        <div className="text-xs text-red-400/80 mt-1 font-mono">{facilitiesError}</div>
                      </div>
                    </div>
                  )}

                  {/* Chart content */}
                  <div className="space-y-4 px-4 pb-16">
                    {activePanels.has('timeseries') && (
                    <SectionCard id="timeseries-panel" title="Zeitreihen-Overlay" hint={CHART_HINTS.timeseries} actions={<RemovePanelButton onRemove={() => hidePanel('timeseries')} label={REMOVABLE_PANEL_LABELS.timeseries} />}>
                      <div id="timeseries-overview-panel">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center">
                            {loading && <span className="text-xs text-yellow-400">Laden...</span>}
                          </div>
                          <span className="text-xs text-gray-500">
                            {seriesDataList.reduce((sum, s) => sum + s.data.length, 0).toLocaleString()} Punkte
                            <span className="ml-2 rounded-full bg-cyan-500/15 px-2 py-0.5 text-cyan-300">
                              ● Roh · native Auflösung
                            </span>
                            {snapshotActive && (
                              <span
                                className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-300"
                                title="Eingefrorene Daten aus einem geteilten Link. Ergebnisse aktualisieren, um gespeicherte Daten zu laden."
                              >
                                📸 Momentaufnahme
                              </span>
                            )}
                            {Object.keys(timeseriesErrors).length > 0 && (
                              <span className="ml-2 text-red-400">
                                {Object.keys(timeseriesErrors).length} Fehler
                              </span>
                            )}
                          </span>
                        </div>
                        {timeseriesRefreshing && seriesDataList.length === 0 ? (
                          // First load: nothing to show yet.
                          <GeneratingLoader minHeight={400} />
                        ) : (
                          // Refresh with data already present: keep the old chart
                          // visible under a thin progress bar for perceived speed,
                          // instead of blanking to a loader.
                          <div className="relative">
                            {timeseriesRefreshing && (
                              <div className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden">
                                <div className="h-full w-1/2 animate-shimmer bg-gradient-to-r from-cyan-500 via-blue-400 to-cyan-500" />
                              </div>
                            )}
                            <div className={timeseriesRefreshing ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
                              <ErrorBoundary label="Zeitreihen-Diagramm">
                                <Suspense fallback={<ChartFallback height={400} />}>
                                  <TimeseriesChart seriesList={seriesDataList} exportBaseName="Zeitreihen-Overlay" />
                                </Suspense>
                              </ErrorBoundary>
                            </div>
                          </div>
                        )}
                        {Object.keys(timeseriesErrors).length > 0 && (
                          <div className="mt-3 space-y-1">
                            {Object.entries(timeseriesErrors).map(([key, msg]) => {
                              const s = selectedSeriesList.find((x) => x.key === key);
                              return (
                                <div key={key} className="flex items-start gap-2 py-1.5 px-3 bg-red-900/20 rounded border border-red-800/40 text-xs">
                                  <span className="text-red-400 shrink-0">⚠</span>
                                  <span className="text-red-300">{s ? `${s.componentName} – ${s.measurementType}` : key}:</span>
                                  <span className="text-red-400/80 font-mono">{msg}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </SectionCard>
                    )}

                    {activePanels.has('heatmap') && (
                    <section id="heatmap-panel" ref={heatmapRef}>
                      <DataSection title="Heatmap" hint={CHART_HINTS.heatmap} loading={analyticsLoading.heatmap} error={heatmapError} isEmpty={false}>
                        <SectionCard title="Heatmap" hint={CHART_HINTS.heatmap} actions={<RemovePanelButton onRemove={() => hidePanel('heatmap')} label={REMOVABLE_PANEL_LABELS.heatmap} />}>
                          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                            <div className="flex items-end gap-3">
                              <SearchableDropdown
                                label=""
                                items={heatmapCandidates}
                                idOf={(series) => series.key}
                                labelOf={(series) => seriesLabel(series)}
                                value={heatmapSelectionKey}
                                onChange={setHeatmapSelectionKey}
                                placeholder="Zeitreihe wählen"
                                emptyHint="Zuerst eine Zeitreihe hinzufügen"
                                className="min-w-[300px]"
                              />
                            </div>
                            <span className="text-xs text-gray-500">
                              {heatmapSelectionKey && heatmapSeries ? seriesLabel(heatmapSeries) : 'Bitte eine bereits hinzugefügte Zeitreihe auswählen'}
                            </span>
                          </div>
                          {analyticsLoading.heatmap ? (
                            <GeneratingLoader minHeight={350} />
                          ) : heatmapSeries && heatmapData && heatmapData.data.length > 0 ? (
                            <ErrorBoundary label="Heatmap">
                              <Suspense fallback={<ChartFallback height={350} />}>
                                <HeatmapChart data={heatmapData} />
                              </Suspense>
                            </ErrorBoundary>
                          ) : (
                            <div className="h-[350px] flex items-center justify-center text-gray-500 text-sm">
                              {heatmapCandidates.length === 0
                                ? 'Zuerst Zeitreihen hinzufügen'
                                : 'Zeitreihe für die Heatmap auswählen'}
                            </div>
                          )}
                        </SectionCard>
                      </DataSection>
                    </section>
                    )}

                    {activePanels.has('peakDemand') && (
                    <SectionCard id="peak-demand-chart-panel" title="Peak Demand Analysis" hint={CHART_HINTS.peakDemand} actions={<RemovePanelButton onRemove={() => hidePanel('peakDemand')} label={REMOVABLE_PANEL_LABELS.peakDemand} />}>
                      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                        <div>
                          {peakDemandRows.length > 0 && selectedPeakDemand && (
                            <div className="mt-1 text-xs text-gray-500">
                              Max. {PEAK_PERIOD_LABELS[peakDemandPeriod].toLowerCase()}: {' '}
                              <span className="text-gray-300">
                                {formatChartNumber(selectedPeakDemand.value)} {selectedPeakDemand.unit}
                              </span>
                              {' '}am {formatPeakTimestamp(selectedPeakDemand.timestamp)}
                            </div>
                          )}
                        </div>
                        <div className="flex flex-wrap items-end justify-end gap-3">
                          <SearchableDropdown
                            label=""
                            items={peakDemandCandidates}
                            idOf={(series) => series.key}
                            labelOf={(series) => seriesLabel(series)}
                            value={peakDemandSelectionKey}
                            onChange={setPeakDemandSelectionKey}
                            placeholder="Wirkleistung wählen"
                            emptyHint="Keine Wirkleistung in der Auswahl"
                            allowReset={false}
                            className="min-w-[300px]"
                          />
                          <div className="inline-flex overflow-hidden rounded border border-gray-600 text-xs">
                            {(Object.keys(PEAK_PERIOD_LABELS) as PeakDemandPeriod[]).map((period) => (
                              <button
                                key={period}
                                type="button"
                                onClick={() => setPeakDemandPeriod(period)}
                                className={`px-2.5 py-1 transition-colors ${
                                  peakDemandPeriod === period
                                    ? 'bg-blue-600 text-white'
                                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white'
                                }`}
                              >
                                {PEAK_PERIOD_LABELS[period]}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      {peakDemandLoading ? (
                        <GeneratingLoader minHeight={350} />
                      ) : peakDemandRows.length === 0 ? (
                        <div className="h-[120px] flex items-center justify-center rounded border border-gray-700 bg-gray-900/40 text-sm text-gray-500">
                          {peakDemandCandidates.length === 0
                            ? 'Wirkleistung (P) auswählen, um Spitzenlasten zu berechnen.'
                            : 'Für die gewählte Wirkleistung sind noch keine Spitzenlastdaten vorhanden.'}
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)] gap-4">
                          <div className="rounded border border-gray-700 bg-gray-900/40 p-3">
                            <ErrorBoundary label="Peak Demand Analysis">
                              <Suspense fallback={<ChartFallback height={350} />}>
                                <PeakDemandChart
                                  rows={peakDemandRows}
                                  selectedIndex={selectedPeakIndex}
                                  onSelect={setSelectedPeakIndex}
                                />
                              </Suspense>
                            </ErrorBoundary>
                          </div>

                          <div className="space-y-3">
                            {selectedPeakDemand && (
                              <div className="rounded border border-gray-700 bg-gray-900/40 p-3">
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <div className="text-xs text-gray-500">{selectedPeakDemand.periodLabel}</div>
                                    <div className="text-lg font-semibold text-white">
                                      {formatChartNumber(selectedPeakDemand.value)} {selectedPeakDemand.unit}
                                    </div>
                                  </div>
                                  <div className="text-right text-xs text-gray-400">
                                    {formatPeakTimestamp(selectedPeakDemand.timestamp)}
                                  </div>
                                </div>
                                <div className="mt-3 space-y-2">
                                  {selectedPeakDemand.contributions.map((contribution) => (
                                    <div key={contribution.key}>
                                      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                                        <span className="truncate text-gray-300">{contribution.label}</span>
                                        <span className="shrink-0 font-mono text-gray-400">
                                          {formatChartNumber(contribution.value)} {selectedPeakDemand.unit}
                                        </span>
                                      </div>
                                      <div className="h-1.5 overflow-hidden rounded-full bg-gray-700">
                                        <div
                                          className="h-full rounded-full bg-blue-500"
                                          style={{ width: `${Math.max(0, Math.min(100, contribution.percent))}%` }}
                                        />
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            <div className="rounded border border-gray-700 bg-gray-900/40 p-3">
                              <div className="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500">Top Peaks</div>
                              <div className="space-y-1">
                                {topPeakDemandRows.map((row) => {
                                  const index = peakDemandRows.findIndex((item) => item.periodKey === row.periodKey);
                                  return (
                                    <button
                                      key={row.periodKey}
                                      type="button"
                                      onClick={() => setSelectedPeakIndex(index)}
                                      className={`grid w-full grid-cols-[70px_minmax(0,1fr)] gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                                        index === selectedPeakIndex
                                          ? 'bg-blue-600/30 text-white'
                                          : 'text-gray-300 hover:bg-gray-700/70'
                                      }`}
                                    >
                                      <span className="font-mono">{formatChartNumber(row.value)} {row.unit}</span>
                                      <span className="truncate text-gray-400">
                                        {row.periodLabel} · {formatPeakTimestamp(row.timestamp)}
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </SectionCard>
                    )}

                    {OFFERED_PANELS.some(([id]) => !activePanels.has(id)) && (
                      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                        <span>Weitere Ansichten hinzufügen:</span>
                        {OFFERED_PANELS.filter(([id]) => !activePanels.has(id)).map(([id, label]) => (
                          <button
                            key={id}
                            type="button"
                            onClick={() => showPanel(id)}
                            className="rounded-full border border-gray-600 px-2.5 py-0.5 transition-colors hover:border-cyan-500 hover:text-cyan-300"
                          >
                            + {label}
                          </button>
                        ))}
                      </div>
                    )}

                    <SectionCard id="custom-charts-panel" className="custom-charts-panel" title="Eigene Diagramme" hint={CHART_HINTS.aggregation} actions={dynamicCharts.length > 0 ? (
                      <button type="button" onClick={clearAllDynamicCharts} className="text-xs text-gray-400 transition-colors hover:text-red-400">Alle Diagramme löschen</button>
                    ) : undefined}>
                      {dynamicCharts.length > 0 && (
                        <>
                          {dynamicCharts.map((chart) => (
                            <DynamicChartCard
                              key={chart.id}
                              instance={chart}
                              availableSeries={selectedSeriesList}
                              dataMap={timeseriesDataMap}
                              startIso={startIso}
                              endIso={endIso}
                              onRemove={removeDynamicChart}
                              onUpdateConfig={updateDynamicChartConfig}
                              resolutions={resolutions}
                            />
                          ))}
                        </>
                      )}

                      <button
                        type="button"
                        onClick={() => setChartPickerOpen(true)}
                        className="add-chart-empty-card"
                        aria-label="Diagramm hinzufügen"
                      >
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <circle cx="12" cy="12" r="9" />
                          <path d="M12 8v8M8 12h8" />
                        </svg>
                        <span className="text-sm font-semibold">Diagramm hinzufügen</span>
                        <span className="text-xs opacity-60">{PICKER_TEMPLATES.length} Analyse-Vorlagen aus {new Set(PICKER_TEMPLATES.map((t) => t.category)).size} Kategorien</span>
                      </button>

                    </SectionCard>
                  </div>
                </section>
              </div>

          </div>
        </div>
      </div>
    </div>
    <ChartTemplatePicker
      open={chartPickerOpen}
      onClose={() => setChartPickerOpen(false)}
      availableSeries={selectedSeriesList}
      resolutions={resolutions}
      startIso={startIso}
      endIso={endIso}
      onGenerate={addDynamicChart}
    />
    </>
  );
}

// -- Map KPI pill --------------------------------------------------------------
// Dark floating card that floats over the map, matching the reference design.

interface MapKpiPillProps {
  label: string;
  value: string;
  unit?: string;
  /** Highlight in primary colour — used for the matched facility name. */
  highlight?: boolean;
  /** Optional clear action for the selected station pill. */
  onClear?: () => void;
}

function MapKpiPill({ label, value, unit, highlight, onClear }: MapKpiPillProps) {
  return (
    <div
      style={{
        position: 'relative',
        background: highlight
          ? 'var(--grid-primary)'
          : 'color-mix(in srgb, var(--grid-bg) 88%, transparent)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderRadius: 14,
        padding: onClear ? '10px 38px 10px 20px' : '10px 20px',
        textAlign: 'center',
        boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
        border: `1px solid ${highlight ? 'transparent' : 'var(--grid-border-soft)'}`,
        minWidth: 80,
      }}
    >
      {onClear && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClear();
          }}
          aria-label="Stationsauswahl aufheben"
          title="Stationsauswahl aufheben"
          style={{
            position: 'absolute',
            top: 6,
            right: 7,
            display: 'grid',
            height: 22,
            width: 22,
            placeItems: 'center',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 999,
            background: 'rgba(255,255,255,0.08)',
            color: 'rgba(255,255,255,0.76)',
            cursor: 'pointer',
            fontSize: 15,
            lineHeight: 1,
            pointerEvents: 'auto',
          }}
        >
          ×
        </button>
      )}
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: '#fff',
          lineHeight: 1.1,
          whiteSpace: 'nowrap',
          maxWidth: 220,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
        {unit && (
          <span style={{ fontSize: 13, fontWeight: 400, opacity: 0.7, marginLeft: 4 }}>
            {unit}
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'rgba(255,255,255,0.55)',
          marginTop: 3,
        }}
      >
        {label}
      </div>
    </div>
  );
}
