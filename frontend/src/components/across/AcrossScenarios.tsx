import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import TimeRangeControl from '../TimeRangeControl';
import { useAcrossData } from '../../hooks/useAcrossData';
import { useGridFilter } from '../../hooks/useGridFilter';
import { gridLabel } from '../../util/grids';
import { SUMMARY_IDS, analyse, compareScenarioCriticality, summarySections, type SummarySection, byStatus, type StatusFilter } from '../../util/acrossScenarios';
import { assessScenario, compareVerdict, equipmentKind, filterByEquipment, type EquipmentKind } from '../../util/outageAssessment';
import ErrorBoundary from '../ErrorBoundary';
import EquipmentFilter, { type EquipmentFilterValue } from './EquipmentFilter';
import AcrossKpis from './AcrossKpis';
import ScenarioDetails from './ScenarioDetails';
import { HelpContext } from './help';
import { SectionCard } from './shared';
import { readParam, writeParam } from '../../util/shareLink';
import type { WorkspaceId } from '../../util/workspaces';

const AcrossCharts = lazy(() => import('./AcrossCharts'));
const ScenarioRadar = lazy(() => import('./ScenarioRadar'));
const ScenarioProfile = lazy(() => import('./ScenarioProfile'));
const TimePointView = lazy(() => import('../views/TimePointView'));
const AssetExplorer = lazy(() => import('../views/AssetExplorer'));
const AreasView = lazy(() => import('../views/AreasView'));
const ScenarioOverview = lazy(() => import('./ScenarioOverview'));
const VoltageMatrix = lazy(() => import('./VoltageMatrix'));
const LineScenarioHeatmap = lazy(() => import('./LineScenarioHeatmap'));
const LineSummaryTable = lazy(() => import('./LineSummaryTable'));

const HELP_KEY = 'across-help';
const readHelp = (): boolean => {
  try { return localStorage.getItem(HELP_KEY) === '1'; } catch { return false; }
};

/**
 * Across-scenarios evaluation, ordered like an outage assessment: result and verdicts first (always
 * loaded), then the chosen scenario, voltage, loading matrix, comparison and the reference table.
 * Everything below the verdicts mounts only when it is scrolled near, and the data arrives scenario
 * by scenario, so a very large database never blocks the first view.
 * Memoised: the page re-renders on every section the user scrolls past (navigation highlight), and a
 * large evaluation takes over a second to render; it only has to follow its own props and data.
 */
function OnDemandPanel({ title, description, children }: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <SectionCard
      className="on-demand-section"
      title={title}
      summary={description}
      defaultOpen={false}
    >
      {children}
    </SectionCard>
  );
}

export default memo(function AcrossScenarios({ refreshKey, workspace, onWorkspaceChange, onSectionsChange }: {
  refreshKey: number;
  workspace: WorkspaceId;
  onWorkspaceChange?: (workspace: WorkspaceId) => void;
  /** Reports the sections currently on screen, for the navigation bar. */
  onSectionsChange?: (sections: SummarySection[]) => void;
}) {
  // `data` is already restricted to the grid chosen in the dashboard header.
  const { data: loaded, total, shown, failed, loading, error } = useAcrossData(refreshKey);
  // Calculation-status filter (?status=…): all scenarios, only complete ones, or only those with a problem.
  const [status, setStatusState] = useState<StatusFilter>(() => {
    const value = readParam('status');
    return value === 'complete' || value === 'problems' ? value : 'all';
  });
  const setStatus = useCallback((value: StatusFilter) => {
    setStatusState(value);
    writeParam('status', value === 'all' ? null : value);
  }, []);
  const data = useMemo(
    () => (loaded && status !== 'all' ? { ...loaded, scenarios: byStatus(loaded.scenarios, status) } : loaded), [loaded, status]);
  // An element clicked on the network map, shown in the asset view.
  const [assetRequest, setAssetRequest] = useState<{ id: string; at: number } | null>(null);
  const pickAsset = useCallback((id: string) => {
    setAssetRequest({ id, at: Date.now() });
    onWorkspaceChange?.('assets');
  }, [onWorkspaceChange]);
  const problemCount = useMemo(() => byStatus(loaded?.scenarios ?? [], 'problems').length, [loaded]);
  const { grid } = useGridFilter();
  // The chosen scenario travels in the address (?scenario=…), so a link or bookmark opens it again.
  const [selected, setSelectedState] = useState<string | null>(() => readParam('scenario'));
  const setSelected = useCallback((id: string | null) => {
    setSelectedState(id);
    writeParam('scenario', id);
  }, []);
  const [kind, setKind] = useState<EquipmentFilterValue>('all');
  const [help, setHelp] = useState(readHelp);
  const toggleHelp = useCallback(() => {
    setHelp((value) => {
      try { localStorage.setItem(HELP_KEY, value ? '0' : '1'); } catch { /* storage unavailable: keep it for this visit */ }
      return !value;
    });
  }, []);

  const buses = useMemo(() => data?.buses ?? [], [data]);
  // The assessment parts (key figures, verdicts, profile, details) always cover all equipment ...
  const full = useMemo(() => (data ? analyse(data) : null), [data]);
  // ... the comparison parts (matrix, charts, radar, table) follow the equipment filter.
  const analysis = useMemo(() => {
    if (!data) return null;
    if (kind === 'all') return full; // the usual case: nothing to filter, nothing to compute twice
    return analyse({ ...data, lines: filterByEquipment(data.lines, kind) });
  }, [data, kind, full]);
  const kindCounts = useMemo(() => {
    const counts: Record<EquipmentKind, number> = { line: 0, transformer: 0, other: 0 };
    for (const line of data?.lines ?? []) counts[equipmentKind(line.type)] += 1;
    return counts;
  }, [data]);
  // ... the verdict never does: it always considers all branches and all busbars.
  const assessments = useMemo(
    () => new Map((data?.scenarios ?? []).map((scenario) => [scenario.id, assessScenario(scenario, data?.lines ?? [], buses)])),
    [data, buses],
  );
  useEffect(() => {
    onSectionsChange?.(full && full.scenarios.length > 0 ? summarySections(full, buses.length) : []);
  }, [full, buses.length, onSectionsChange]);
  const defaultId = useMemo(
    () => (full
      ? [...full.scenarios].sort((a, b) => {
          const x = assessments.get(a.scenario.id);
          const y = assessments.get(b.scenario.id);
          return (x && y ? compareVerdict(x, y) : 0) || compareScenarioCriticality(a, b);
        })[0]?.scenario.id ?? null
      : null),
    [full, assessments],
  );
  const selectedId = selected && full?.scenarios.some((s) => s.scenario.id === selected) ? selected : defaultId;
  // The asset view: every branch and busbar of the analysis, starting with the branch of the highest loading.
  const assetItems = useMemo(() => [
    ...(full?.lines ?? []).map((s) => ({ id: s.line.id, name: s.line.name, class_name: s.line.class_name, type: s.line.type, nominal_kv: s.line.nominal_kv })),
    ...buses.map((b) => ({ id: b.id, name: b.name, class_name: b.class_name, type: b.type, nominal_kv: b.nominal_kv })),
  ].sort((a, b) => a.name.localeCompare(b.name, 'en')), [full, buses]);
  const worstBranch = useMemo(
    () => [...(full?.lines ?? [])].sort((a, b) => (b.max ?? -Infinity) - (a.max ?? -Infinity))[0]?.line.id ?? null, [full]);
  const scenarioCodes = useMemo(() => new Map((full?.scenarios ?? []).map((s) => [s.scenario.id, s.code])), [full]);
  const selectedScenario = full?.scenarios.find((s) => s.scenario.id === selectedId) ?? null;

  if (error && !data) return <p role="alert" className="mt-4 text-sm text-[var(--grid-danger)]">{error}</p>;
  if (!analysis || !full || full.scenarios.length === 0) {
    if (loading || (data && total > 0 && shown === 0 && failed < total)) {
      return <p className="mt-4 text-sm text-[var(--grid-muted)]" aria-busy>Loading scenarios …</p>;
    }
    if (status !== 'all' && (loaded?.scenarios.length ?? 0) > 0) {
      return (
        <p className="mt-4 text-sm text-[var(--grid-muted)]">
          No scenario matches the status filter. <button type="button" className="ab-chip" onClick={() => setStatus('all')}>Show all scenarios</button>
        </p>
      );
    }
    return <p className="mt-4 text-sm text-[var(--grid-muted)]">No calculated scenarios yet.</p>;
  }
  const periodHours = data!.period_hours;
  return (
    <HelpContext.Provider value={help}>
      <div className="across-scope mt-4 grid gap-3" aria-label="Across-scenarios evaluation">
        <div className="ab-toolbar">
          {loading && shown < total ? (
            <div className="ab-progress" role="status" aria-live="polite">
              <span className="ab-progress__bar" aria-hidden><span style={{ width: `${(shown / Math.max(total, 1)) * 100}%` }} /></span>
              scenarios {shown} / {total}
            </div>
          ) : failed > 0 ? (
            <span className="ab-progress" role="status">{failed} of {total} scenarios could not be loaded.</span>
          ) : <span />}
          <div className="ab-chips">
            <label className="ab-sub" htmlFor="status-filter">Calculation status</label>
            <select id="status-filter" className="ab-control" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="all">All scenarios</option>
              <option value="complete">Complete only</option>
              <option value="problems">With problems ({problemCount})</option>
            </select>
            <button type="button" className="ab-chip" aria-pressed={help} onClick={toggleHelp} title="Show or hide the explanations of all sections">Explanations</button>
          </div>
          <TimeRangeControl />
        </div>
        {data!.listing && (
          <p className="ab-progress" role="note">
            Large analysis: {data!.listing.listed_lines.toLocaleString('en-GB')} of {data!.listing.lines.toLocaleString('en-GB')} branches
            and {data!.listing.listed_buses.toLocaleString('en-GB')} of {data!.listing.buses.toLocaleString('en-GB')} busbars are listed:
            every branch switched off, at or above {data!.listing.warning} % or above a limit at any time, every busbar
            outside or within {data!.listing.margin} p.u. of {data!.listing.band[0]}–{data!.listing.band[1]} p.u., and the
            {' '}{data!.listing.top} highest loadings, changes and voltage deviations per scenario. Verdicts and key figures are
            complete; an element not listed in a scenario stays below these values there (shown as –).
          </p>
        )}

        {workspace === 'assessment' && (
          <SectionCard
            id={SUMMARY_IDS.kpis}
            title="Assessment overview"
            summary={`${full.scenarios.length} scenarios · ${grid === null ? 'all grids' : gridLabel(grid)} · ${full.lines.length} equipment${buses.length ? ` · ${buses.length} busbars` : ''}`}
          >
            <AcrossKpis kpis={full.kpis} scenarios={full.scenarios} assessments={assessments} />
          </SectionCard>
        )}

        {workspace === 'scenarios' && (
          <>
            {selectedScenario && (
              <ErrorBoundary label="Loading profile">
                <Suspense fallback={<div className="ab-empty" aria-busy>Loading profile …</div>}>
                  <ScenarioProfile scenarioId={selectedScenario.scenario.id} label={`${selectedScenario.code} ${selectedScenario.scenario.name}`} refreshKey={refreshKey} />
                </Suspense>
              </ErrorBoundary>
            )}
            <ScenarioDetails scenarios={full.scenarios} selectedId={selectedId} onSelect={setSelected} />
            <OnDemandPanel
              title="Scenario list"
              description={`${full.scenarios.length} scenarios with outage windows, verdicts and criticality.`}
            >
              <Suspense fallback={<div className="ab-empty" aria-busy>Loading scenario table …</div>}>
                <ScenarioOverview scenarios={full.scenarios} assessments={assessments} selectedId={selectedId} onSelect={setSelected} periodHours={periodHours} period={data!.period} />
              </Suspense>
            </OnDemandPanel>
          </>
        )}

        {workspace === 'network' && selectedScenario && (
          <>
            <ErrorBoundary label="Network at a time">
              <Suspense fallback={<div className="ab-empty" aria-busy>Loading network view …</div>}>
                <TimePointView scenarioId={selectedScenario.scenario.id} label={`${selectedScenario.code} ${selectedScenario.scenario.name}`} refreshKey={refreshKey} onPickAsset={pickAsset} />
              </Suspense>
            </ErrorBoundary>
            <ErrorBoundary label="Areas">
              <Suspense fallback={<div className="ab-empty" aria-busy>Loading areas …</div>}>
                <AreasView scenarioId={selectedScenario.scenario.id} label={`${selectedScenario.code} ${selectedScenario.scenario.name}`} refreshKey={refreshKey} />
              </Suspense>
            </ErrorBoundary>
            {buses.length > 0 && (
              <OnDemandPanel
                title="Busbar voltage matrix"
                description={`${buses.length} busbars across ${full.scenarios.length} scenarios. Expand for cell-level evidence.`}
              >
                <Suspense fallback={<div className="ab-empty" aria-busy>Loading voltage matrix …</div>}>
                  <VoltageMatrix buses={buses} scenarios={full.scenarios} selectedId={selectedId} onSelect={setSelected} />
                </Suspense>
              </OnDemandPanel>
            )}
          </>
        )}

        {workspace === 'assets' && (
          <ErrorBoundary label="Asset">
            <Suspense fallback={<div className="ab-empty" aria-busy>Loading asset view …</div>}>
              <AssetExplorer items={assetItems} defaultId={worstBranch} codes={scenarioCodes} requested={assetRequest} />
            </Suspense>
          </ErrorBoundary>
        )}

        {workspace === 'compare' && (
          <>
            <SectionCard id={SUMMARY_IDS.charts} title="Scenario comparison" summary={`${analysis.scenarios.length} scenarios · ${analysis.lines.length} equipment`}>
              <ErrorBoundary label="Evaluation charts">
                <Suspense fallback={<div className="ab-empty" aria-busy>Loading charts …</div>}>
                  <AcrossCharts lines={analysis.lines} scenarios={analysis.scenarios} periodHours={periodHours} hasLodf={data!.has_lodf} />
                </Suspense>
              </ErrorBoundary>
            </SectionCard>
            <ErrorBoundary label="Scenario radar plot">
              <Suspense fallback={<div className="ab-empty" aria-busy>Loading radar plot …</div>}>
                <ScenarioRadar scenarios={analysis.scenarios} selectedId={selectedId} onSelect={setSelected} />
              </Suspense>
            </ErrorBoundary>
            <OnDemandPanel
              title="Equipment × scenario matrix"
              description={`${analysis.lines.length} equipment items across ${analysis.scenarios.length} scenarios.`}
            >
              <div className="grid gap-3">
                <EquipmentFilter value={kind} onChange={setKind} counts={kindCounts} />
                <Suspense fallback={<div className="ab-empty" aria-busy>Loading equipment matrix …</div>}>
                  <LineScenarioHeatmap lines={analysis.lines} scenarios={analysis.scenarios} selectedId={selectedId} onSelect={setSelected} />
                </Suspense>
              </div>
            </OnDemandPanel>
            <OnDemandPanel
              title="Detailed equipment table"
              description="Every calculated value and scenario relationship for audit or export work."
            >
              <Suspense fallback={<div className="ab-empty" aria-busy>Loading detail table …</div>}>
                <LineSummaryTable lines={analysis.lines} scenarios={analysis.scenarios} hasLodf={data!.has_lodf} periodHours={periodHours} />
              </Suspense>
            </OnDemandPanel>
          </>
        )}
      </div>
    </HelpContext.Provider>
  );
});
