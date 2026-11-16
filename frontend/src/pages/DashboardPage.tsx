// @refresh reset  ← force full remount on hot reload so stale React state
// (e.g. resolutions carrying a non-array HMR-preserved value) never leaks into
// child components.
import { useEffect, useState, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import {
  getFacilities,
  searchComponents,
  getMeasurementTypes,
  getTimeseries,
  getResolutions,
  clearCache,
  RawRangeTooLargeError,
  type Facility,
  type GridComponent,
  type MeasurementTypeInfo,
  type ResolutionInfo,
  type TimeseriesData,
} from '../api/client';
// Chart components are lazy-loaded. Each one pulls in its slice of ECharts
// (~150-300 KB) as a separate chunk, so the dashboard's first paint only
// downloads the bare frame + dropdowns. Charts then stream in as the user
// scrolls / switches tabs.
const TimeseriesChart          = lazy(() => import('../components/charts/TimeseriesChart'));
import ErrorBoundary from '../components/ErrorBoundary';
import SearchableDropdown from '../components/SearchableDropdown';
import GridPicker from '../components/GridPicker';
import AnalysisPicker from '../components/AnalysisPicker';
import ShareLink from '../components/ShareLink';
import LimitsDialog from '../components/LimitsDialog';
import Bookmarks from '../components/Bookmarks';
import CompareDialog from '../components/CompareDialog';
import VoltageLevelPicker from '../components/VoltageLevelPicker';
import { SectionExpansionContext, type SectionExpansion } from '../hooks/useSectionExpansion';
import { useAnalysis } from '../hooks/useAnalysis';
import { useGridFilter } from '../hooks/useGridFilter';
import { inGrid, atVoltage } from '../util/grids';
import DynamicChartCard from '../components/DynamicChartCard';
import ChartTemplatePicker from '../components/ChartTemplatePicker';
import { MTYPE_LABELS, type DashboardChartConfig, type DynamicChartConfig } from '../util/dynamicCharts';
import {
  saveLocalView,
  loadLocalView,
  clearLocalView,
  type SavedView,
} from '../util/savedView';
import { logError } from '../debug/debugLog';
import CinematicThemeSwitch from '../components/ui/cinematic-theme-switcher';
import { applyGridThemeMode, storedThemeMode, type ThemeMode } from '../util/theme';
import AnimatedButton from '../components/ui/AnimatedButton';
import OutageManagement from '../components/OutageManagement';
import { CHART_TEMPLATES } from '../components/charts/chartTemplates';
import { SectionCard } from '../components/across/shared';
import AcrossScenarios from '../components/across/AcrossScenarios';
import DashboardSection from '../components/DashboardSection';
import { useWorkspaceScroll } from '../hooks/useWorkspaceScroll';
import DatabasePicker from '../components/DatabasePicker';
import GeneratingLoader from '../components/ui/GeneratingLoader';
import WorkspaceRail from '../components/WorkspaceRail';
import { isWorkspaceId, workspaceDefinition, type WorkspaceId } from '../util/workspaces';
import { readParam, writeParam } from '../util/shareLink';

// Up to this many elements the equipment list is loaded whole and searched in the browser; a larger run is searched
// on the server, a page of SEARCH_PAGE matches at a time.
const COMPLETE_LIST_LIMIT = 2000;
const SEARCH_PAGE = 200;

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
    return `${status} – ${detail || 'Unknown server error'} (${url})`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

interface SelectedSeries {
  key: string;
  facilityName: string;
  facilityId: string;
  componentId: string;
  componentName: string;
  measurementType: string;
  grid?: string | null;
  nominalKv?: number | null;
  className?: string | null;
}

const APP_NAME = 'Outage Assessment';

const CHART_HINTS = {
  timeseries: 'Complete simulation series of the selected measurements.',
  custom: 'Additional charts of the selected signals or of all scenarios, with selectable aggregation and limits.',
} as const;

/** Optional views. Only the summary is standard; these appear when the user adds them. */
const REMOVABLE_PANEL_LABELS: Record<string, string> = {
  timeseries: 'Time series overlay',
};

/** Optional views offered under the summary. */
const OFFERED_PANELS = Object.entries(REMOVABLE_PANEL_LABELS);

/** Small "x" button on an optional view's header; removes it again. */
function RemovePanelButton({ onRemove, label }: { onRemove: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label={`Remove ${label}`}
      title={`Remove ${label}`}
      className="ml-2 rounded px-1.5 py-0.5 text-gray-500 transition-colors hover:bg-red-900/30 hover:text-red-400"
    >
      ✕
    </button>
  );
}

export default function DashboardPage() {
  const [sectionExpansion, setSectionExpansion] = useState<SectionExpansion>({ revision: 0 });
  const setAllSectionsOpen = (open: boolean) => {
    setSectionExpansion(previous => ({ revision: previous.revision + 1, open }));
  };
  const [workspace, setWorkspaceState] = useState<WorkspaceId>(() => {
    const value = readParam('view');
    return isWorkspaceId(value) ? value : 'assessment';
  });
  const tabScrollRef = useRef<HTMLDivElement>(null);
  const activateWorkspace = useCallback((next: WorkspaceId) => {
    setWorkspaceState(next);
    writeParam('view', next === 'assessment' ? null : next);
  }, []);
  const setWorkspace = useWorkspaceScroll(tabScrollRef, workspace, activateWorkspace);
  const workspaceMeta = workspaceDefinition(workspace);
  // Restore the locally persisted view once on mount, so a reload (or recovery after a dropped
  // connection) is lossless.
  const initialView = useMemo(() => loadLocalView(), []);
  // Selection to restore from localStorage. The facility ->
  // component -> measurement cascade effects below reset their child selection
  // whenever the parent changes; without this they would wipe a restored
  // selection on the first pass. Honored once, then cleared.
  const restoreRef = useRef<{ fac: string | null; cmp: string | null; mt: string } | null>(
    initialView ? { fac: initialView.fac, cmp: initialView.cmp, mt: initialView.mt } : null,
  );
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [selectedFacilityId, setSelectedFacilityId] = useState<string | null>(initialView?.fac ?? null);
  const [components, setComponents] = useState<GridComponent[]>([]);
  // null: `components` is the complete list of the run. A number: the run is too large for that and `components` is
  // one page of server matches for the search text (componentQuery), of `componentTotal` in all.
  const [componentTotal, setComponentTotal] = useState<number | null>(null);
  const [componentQuery, setComponentQuery] = useState('');
  // The chosen element, kept when a new search page no longer contains it.
  const [pinnedComponent, setPinnedComponent] = useState<GridComponent | null>(null);
  const { grid, kv } = useGridFilter();
  // The equipment dropdown offers only the equipment of the chosen grid.
  const gridComponents = useMemo(() => components.filter((c) => inGrid(c, grid) && atVoltage(c, kv)), [components, grid, kv]);
  const listedComponents = useMemo(
    () => (pinnedComponent && !gridComponents.some((c) => c.id === pinnedComponent.id) ? [pinnedComponent, ...gridComponents] : gridComponents),
    [gridComponents, pinnedComponent]);
  const [selectedComponentId, setSelectedComponentId] = useState<string | null>(initialView?.cmp ?? null);
  const [measurementTypes, setMeasurementTypes] = useState<MeasurementTypeInfo[]>([]);
  const [selectedMtype, setSelectedMtype] = useState<string>(initialView?.mt ?? '');

  const [selectedSeriesList, setSelectedSeriesList] = useState<SelectedSeries[]>(initialView?.series ?? []);
  const [timeseriesDataMap, setTimeseriesDataMap] = useState<Record<string, TimeseriesData>>({});

  // Error tracking
  const [facilitiesError, setFacilitiesError] = useState<string | null>(null);
  const [timeseriesErrors, setTimeseriesErrors] = useState<Record<string, string>>({});

  const [loading, setLoading] = useState(false);
  const [facilitiesLoading, setFacilitiesLoading] = useState(false);
  const [componentsLoading, setComponentsLoading] = useState(false);
  const [measurementTypesLoading, setMeasurementTypesLoading] = useState(false);
  const [timeseriesLoadingKeys, setTimeseriesLoadingKeys] = useState<Set<string>>(() => new Set());
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => storedThemeMode());
  const [resolutions, setResolutions] = useState<ResolutionInfo[]>([
    { minutes: 60, label: '1 hour' },
    { minutes: 240, label: '4 hours' },
    { minutes: 1440, label: '1 day' },
  ]);
  // The overview always shows raw, native-resolution data. Aggregation is a
  // deliberate, separate action: the user adds a dedicated aggregated chart
  // via the chart picker — it is never applied to the raw overview.
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Generic generated-chart state. Replaces the former aggregation-only list:
  // each entry is a fully self-describing DashboardChartConfig rendered by a
  // DynamicChartCard.
  const [dynamicCharts, setDynamicCharts] = useState<DashboardChartConfig[]>(initialView?.charts ?? []);
  const [chartPickerOpen, setChartPickerOpen] = useState(false);

  // Optional views (time series overlay). None is shown by default; the user adds them
  // explicitly and removes them again.
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
        `Really remove ${prev.length} chart${prev.length === 1 ? '' : 's'}? This cannot be undone.`,
      );
      return confirmed ? [] : prev;
    });
  }, []);

  const updateDynamicChartConfig = useCallback((id: string, config: DynamicChartConfig) => {
    setDynamicCharts((prev) => prev.map((chart) => (
      chart.id === id ? { ...chart, config } : chart
    )));
  }, []);

  // The current view as a serialisable snapshot.
  const currentView = useMemo<SavedView>(() => ({
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

  // Track the previous component key so we can distinguish a component change
  // (clear stale data) from a date-range change (keep old data visible while
  // re-fetching — optimistic display).
  const timeseriesScopeByKeyRef = useRef<Record<string, string>>({});

  // null means the n-1 availability check has not completed yet.

  const { analysis } = useAnalysis();
  const lastFacilityRefreshRef = useRef(0);
  const refreshFacilities = useCallback(() => {
    setFacilitiesLoading(true);
    return getFacilities(undefined, analysis)
      .then((data) => {
        setFacilities(data);
        setFacilitiesError(null);
        lastFacilityRefreshRef.current = Date.now();
      })
      .catch((err) => {
        const msg = extractError(err);
        setFacilities([]);
        setFacilitiesError(msg);
        logError('Dashboard', 'Scenarios could not be loaded', msg);
      })
      .finally(() => setFacilitiesLoading(false));
  }, [analysis]);

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
  // it obvious data is present).
  // A run of another analysis is not offered: fall back to the first run of the chosen one.
  useEffect(() => {
    if (facilities.length > 0 && (!selectedFacilityId || !facilities.some((f) => f.id === selectedFacilityId))) {
      setSelectedFacilityId(facilities[0].id);
    }
  }, [facilities, selectedFacilityId]);

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
    searchComponents(selectedFacilityId, { limit: COMPLETE_LIST_LIMIT })
      .then(({ items: data, total }) => {
        if (!active) return;
        setComponents(data);
        setComponentTotal(total > data.length ? total : null);
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
        logError('Dashboard', 'Equipment could not be loaded', extractError(err));
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
        logError('Dashboard', 'Measurements could not be loaded', extractError(err));
      })
      .finally(() => { if (active) setMeasurementTypesLoading(false); });
    return () => { active = false; };
  }, [selectedComponentId]);

  // A large run: every change of the search text, grid or voltage level asks the server for the matching page.
  const serverSearch = componentTotal !== null;
  useEffect(() => {
    if (!serverSearch || !selectedFacilityId) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchComponents(selectedFacilityId, { q: componentQuery, grid, kv, limit: SEARCH_PAGE }, controller.signal)
        .then(({ items, total }) => { setComponents(items); setComponentTotal(total); })
        .catch(() => { /* aborted by a newer search, or kept the previous page */ });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [serverSearch, componentQuery, grid, kv, selectedFacilityId]);

  useEffect(() => {
    const found = components.find((c) => c.id === selectedComponentId);
    if (found) setPinnedComponent(found);
    else if (!selectedComponentId) setPinnedComponent(null);
  }, [components, selectedComponentId]);

  // Choosing another grid drops an equipment selection that is not part of it (complete lists only: a search page
  // of a large run need not contain the chosen element).
  useEffect(() => {
    if (componentsLoading || !selectedComponentId || componentTotal !== null) return;
    if (!gridComponents.some((c) => c.id === selectedComponentId)) setSelectedComponentId(null);
  }, [gridComponents, selectedComponentId, componentsLoading, componentTotal]);

  const addSeries = useCallback(() => {
    if (!selectedComponentId || !selectedMtype || !selectedFacilityId) return;
    const comp = components.find((c) => c.id === selectedComponentId) ?? pinnedComponent ?? undefined;
    const fac = facilities.find((f) => f.id === selectedFacilityId);
    if (!comp || !fac) return;
    const key = `${selectedComponentId}-${selectedMtype}`;
    if (selectedSeriesList.some((s) => s.key === key)) return;
    setSelectedSeriesList((prev) => [
      ...prev,
      {
        key,
        facilityName: fac.name,
        facilityId: fac.id,
        componentId: selectedComponentId,
        componentName: comp.name,
        measurementType: selectedMtype,
        grid: comp.grid ?? null,
        nominalKv: comp.nominal_kv ?? null,
        className: comp.class_name ?? null,
      },
    ]);
  }, [selectedComponentId, selectedMtype, selectedFacilityId, components, pinnedComponent, facilities, selectedSeriesList]);

  // Views saved before plot-level filters did not carry equipment metadata. Enrich them from the
  // current component catalogue once it arrives, without changing their keys or source selection.
  useEffect(() => {
    if (components.length === 0) return;
    const byId = new Map(components.map((component) => [component.id, component]));
    setSelectedSeriesList((previous) => {
      let changed = false;
      const next = previous.map((series) => {
        const component = byId.get(series.componentId);
        if (!component || (series.grid !== undefined && series.nominalKv !== undefined && series.className !== undefined)) return series;
        changed = true;
        return {
          ...series,
          grid: component.grid ?? null,
          nominalKv: component.nominal_kv ?? null,
          className: component.class_name ?? null,
        };
      });
      return changed ? next : previous;
    });
  }, [components]);

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

    // Raw time-series reads can be large. They are only useful in the chart
    // workspace, so a restored view no longer starts them on the assessment.
    if (workspace !== 'charts') {
      setTimeseriesLoadingKeys(new Set());
      setLoading(false);
      return;
    }

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

    const seriesToFetch = selectedSeriesList.filter(
      (series) => timeseriesScopeByKeyRef.current[series.key] !== scopeKey,
    );

    if (seriesToFetch.length === 0) {
      setTimeseriesLoadingKeys(new Set());
      setLoading(false);
      return;
    }

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
    // Started at once: there is no date picker any more, so nothing has to settle first, and the server is on this PC.
    const timer = setTimeout(() => {
      // The overview is always raw (native resolution). No silent aggregation.
      // Four reads at a time: the database is a local file, and the results render progressively.
      const CONCURRENCY = 4;
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
              ? `Time range too large for raw data${err.estimatedPoints ? ` (~${err.estimatedPoints.toLocaleString()} points)` : ''}. Shorten the simulation or add an aggregated chart.`
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
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
      setTimeseriesLoadingKeys(new Set());
      setLoading(false);
    };
  }, [selectedSeriesList, startIso, endIso, refreshNonce, workspace]);

  const seriesDataList = useMemo(
    () => selectedSeriesList.flatMap((s) => {
      const data = timeseriesDataMap[s.key];
      return data ? [{ ...data, component_name: `${s.facilityName} / ${s.componentName}` }] : [];
    }),
    [selectedSeriesList, timeseriesDataMap],
  );

  const timeseriesRefreshing = loading || timeseriesLoadingKeys.size > 0;
  const assessmentIntro = useMemo(() => <OutageManagement onResultsChanged={() => {
    clearCache(); refreshFacilities(); setRefreshNonce((n) => n + 1);
  }} />, [refreshFacilities]);

  return (
    <SectionExpansionContext.Provider value={sectionExpansion}>
    <div className="grid-theme-scope dashboard-shell h-screen flex flex-col bg-[var(--grid-bg)] text-[var(--grid-text)] overflow-hidden">
      <header className="dashboard-topbar">
        <div className="dashboard-topbar__brand">
          <DatabasePicker />
          <h1 className="truncate text-base font-bold tracking-tight text-[var(--grid-text)]">{APP_NAME}</h1>
        </div>
        <div className="dashboard-topbar__context" aria-live="polite">
          <span>{workspaceMeta.label}</span>
          <small>{workspaceMeta.description}</small>
        </div>
        <div className="dashboard-topbar__actions">
          <div role="group" aria-label="Expand or collapse dashboard sections" className="flex items-center gap-1">
            <button type="button" className="ab-chip" onClick={() => setAllSectionsOpen(false)} title="Collapse all cards">Collapse</button>
            <button type="button" className="ab-chip" onClick={() => setAllSectionsOpen(true)} title="Expand all cards">Expand</button>
          </div>
          <Bookmarks />
          <CompareDialog refreshKey={refreshNonce} />
          <LimitsDialog />
          <ShareLink />
          <CinematicThemeSwitch value={themeMode} onChange={setThemeMode} />

        </div>
      </header>


      <div className="dashboard-workbench">
        <WorkspaceRail value={workspace} onChange={setWorkspace} />
        <main className="workspace-main">
          <section className="analysis-context-bar" aria-label="Analysis context">
            <div className="flex flex-wrap items-start gap-3">
              <AnalysisPicker refreshKey={refreshNonce} />
              <GridPicker refreshKey={refreshNonce} />
              <VoltageLevelPicker refreshKey={refreshNonce} />
              <div className="flex items-start gap-1">
                <SearchableDropdown
                  label="Scenario"
                  items={Array.isArray(facilities) ? facilities : []}
                  idOf={(f) => f.id}
                  labelOf={(f) => `${f.name}${f.project ? ` · ${f.project}` : ''}`}
                  value={selectedFacilityId}
                  onChange={setSelectedFacilityId}
                  placeholder="- Scenario -"
                  emptyHint="No calculated scenarios yet"
                  loading={facilitiesLoading}
                  loadingLabel="Loading scenarios"
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
                    title="Reload scenarios and charts"
                    className={`flex h-10 w-10 items-center justify-center rounded border border-gray-600 bg-gray-700 text-sm text-gray-400 transition-colors hover:bg-gray-600 hover:text-white ${facilitiesLoading ? 'animate-pulse' : ''}`}
                  >
                    ↻
                  </button>
                </div>
              </div>
              {/* Equipment and measurement are offered in every workspace; their time series are drawn under Charts. */}
              <SearchableDropdown
                label="Equipment"
                items={listedComponents}
                onQueryChange={componentTotal === null ? undefined : setComponentQuery}
                totalCount={componentTotal ?? undefined}
                idOf={(c) => c.id}
                labelOf={(c) => `${c.name}${c.class_name ? ` (${c.class_name})` : ''}${c.nominal_kv ? ` · ${c.nominal_kv} kV` : ''}`}
                searchOf={(c) => [c.name, c.id, c.class_name ?? '', c.nominal_kv ? `${c.nominal_kv} kV` : ''].join(' ')}
                value={selectedComponentId}
                onChange={setSelectedComponentId}
                placeholder="- Equipment - (name, ID, kV level)"
                  emptyHint="No equipment"
                  disabled={!selectedFacilityId}
                  loading={componentsLoading}
                  loadingLabel="Loading equipment"
                  className="min-w-[240px]"
                />
              <SearchableDropdown
                label="Measurement"
                items={measurementTypes}
                idOf={(mt) => mt.type}
                labelOf={(mt) => `${MTYPE_LABELS[mt.type] || mt.type} (${mt.unit})`}
                value={selectedMtype || null}
                onChange={(v) => setSelectedMtype(v ?? '')}
                placeholder="- Measurement -"
                emptyHint="No measurements"
                disabled={!selectedComponentId}
                loading={measurementTypesLoading}
                loadingLabel="Loading measurements"
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
                  Add
                </AnimatedButton>
              </div>

            </div>

            {selectedSeriesList.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-gray-700">
                {workspace !== 'charts' && (
                  <button type="button" className="ab-chip" onClick={() => setWorkspace('charts')}
                    title="The added time series are drawn in the Charts workspace">
                    Show in Charts →
                  </button>
                )}
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
                  Clear all
                </button>
              </div>
            )}

          </section>

          <div ref={tabScrollRef} className="flex-1 overflow-y-auto">
            <AcrossScenarios refreshKey={refreshNonce} onWorkspaceChange={setWorkspace} intro={assessmentIntro} />
            <DashboardSection workspace="charts" lazy>
                {/* -- Charts overlay: rises up over the sticky map ------- */}
                <section
                  className="charts-overlay"
                  aria-label="Time series charts"
                >
                  {facilitiesError && (
                    <div className="mx-4 mb-3 flex items-start gap-3 py-3 px-4 bg-red-900/20 rounded border border-red-800/40">
                      <span className="text-red-400 text-xl shrink-0">⚠</span>
                      <div>
                        <div className="text-sm text-red-300 font-medium">Scenarios could not be loaded</div>
                        <div className="text-xs text-red-400/80 mt-1 font-mono">{facilitiesError}</div>
                      </div>
                    </div>
                  )}

                  {/* Chart content */}
                  <div className="space-y-4 px-4 pb-16">
                    {activePanels.has('timeseries') && (
                    <SectionCard id="timeseries-panel" title="Time series overlay" hint={CHART_HINTS.timeseries} actions={<RemovePanelButton onRemove={() => hidePanel('timeseries')} label={REMOVABLE_PANEL_LABELS.timeseries} />}>
                      <div id="timeseries-overview-panel">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center">
                            {loading && <span className="text-xs text-yellow-400">Loading...</span>}
                          </div>
                          <span className="text-xs text-gray-500">
                            {seriesDataList.reduce((sum, s) => sum + s.data.length, 0).toLocaleString()} points
                            <span className="ml-2 rounded-full bg-cyan-500/15 px-2 py-0.5 text-cyan-300">
                              ● Raw · native resolution
                            </span>
                            {Object.keys(timeseriesErrors).length > 0 && (
                              <span className="ml-2 text-red-400">
                                {Object.keys(timeseriesErrors).length} errors
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
                              <ErrorBoundary label="Time series chart">
                                <Suspense fallback={<ChartFallback height={400} />}>
                                  <TimeseriesChart seriesList={seriesDataList} exportBaseName="Time series overlay" />
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

                    {OFFERED_PANELS.some(([id]) => !activePanels.has(id)) && (
                      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                        <span>Add more views:</span>
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

                    <SectionCard id="custom-charts-panel" className="custom-charts-panel" title="Added charts" hint={CHART_HINTS.custom} actions={dynamicCharts.length > 0 ? (
                      <button type="button" onClick={clearAllDynamicCharts} className="text-xs text-gray-400 transition-colors hover:text-red-400">Delete all charts</button>
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
                        aria-label="Add chart"
                      >
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <circle cx="12" cy="12" r="9" />
                          <path d="M12 8v8M8 12h8" />
                        </svg>
                        <span className="text-sm font-semibold">Add chart</span>
                        <span className="text-xs opacity-60">{CHART_TEMPLATES.length} chart templates in {new Set(CHART_TEMPLATES.map((t) => t.category)).size} categories</span>
                      </button>

                    </SectionCard>
                  </div>
                </section>
            </DashboardSection>

          </div>
        </main>
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
    </SectionExpansionContext.Provider>
  );
}
