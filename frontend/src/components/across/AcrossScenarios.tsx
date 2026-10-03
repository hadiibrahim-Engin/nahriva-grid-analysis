import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { useAcrossData } from '../../hooks/useAcrossData';
import { SUMMARY_IDS, analyse, compareScenarioCriticality, summarySections, type SummarySection } from '../../util/acrossScenarios';
import { assessScenario, compareVerdict, equipmentKind, filterByEquipment, type EquipmentKind } from '../../util/outageAssessment';
import ErrorBoundary from '../ErrorBoundary';
import EquipmentFilter, { type EquipmentFilterValue } from './EquipmentFilter';
import AcrossKpis from './AcrossKpis';
import LineScenarioHeatmap from './LineScenarioHeatmap';
import LineSummaryTable from './LineSummaryTable';
import ScenarioDetails from './ScenarioDetails';
import ScenarioOverview from './ScenarioOverview';
import VoltageMatrix from './VoltageMatrix';
import { HelpContext } from './help';
import LazySection from './LazySection';
import { SectionCard } from './shared';

const AcrossCharts = lazy(() => import('./AcrossCharts'));
const ScenarioRadar = lazy(() => import('./ScenarioRadar'));
const ScenarioProfile = lazy(() => import('./ScenarioProfile'));

const HELP_KEY = 'across-help';
const readHelp = (): boolean => {
  try { return localStorage.getItem(HELP_KEY) === '1'; } catch { return false; }
};

/**
 * Across-scenarios evaluation, ordered like an outage assessment: result and verdicts first (always
 * loaded), then the chosen scenario, voltage, loading matrix, comparison and the reference table.
 * Everything below the verdicts mounts only when it is scrolled near, and the data arrives scenario
 * by scenario, so a very large database never blocks the first view.
 */
export default function AcrossScenarios({ refreshKey, onSectionsChange }: {
  refreshKey: number;
  /** Reports the sections currently on screen, for the navigation bar. */
  onSectionsChange?: (sections: SummarySection[]) => void;
}) {
  const { data, total, shown, failed, loading, error } = useAcrossData(refreshKey);
  const [selected, setSelected] = useState<string | null>(null);
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
  const selectedScenario = full?.scenarios.find((s) => s.scenario.id === selectedId) ?? null;

  if (error && !data) return <p role="alert" className="mt-4 text-sm text-[var(--grid-danger)]">{error}</p>;
  if (!analysis || !full || full.scenarios.length === 0) {
    if (loading || (data && total > 0 && shown === 0 && failed < total)) {
      return <p className="mt-4 text-sm text-[var(--grid-muted)]" aria-busy>Loading scenarios …</p>;
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
          <button type="button" className="ab-chip" aria-pressed={help} onClick={toggleHelp} title="Show or hide the explanations of all sections">Explanations</button>
        </div>
        {/* 1 · Result first: key figures and the verdict per scenario, always over all equipment */}
        <SectionCard id={SUMMARY_IDS.kpis} title="Key figures" summary={`${full.scenarios.length} scenarios · ${full.lines.length} Equipment${buses.length ? ` · ${buses.length} Busbars` : ''}`}>
          <AcrossKpis kpis={full.kpis} scenarios={full.scenarios} assessments={assessments} />
        </SectionCard>
        <ScenarioOverview scenarios={full.scenarios} assessments={assessments} selectedId={selectedId} onSelect={setSelected} periodHours={periodHours} period={data!.period} />
        {/* 2 · The chosen scenario in detail: when is it critical, what does it contain */}
        {selectedScenario && (
          <LazySection id={SUMMARY_IDS.profile} label="Loading profile" minHeight={160}>
            <ErrorBoundary label="Loading profile">
              <Suspense fallback={<div className="ab-empty" aria-busy>Loading profile …</div>}>
                <ScenarioProfile scenarioId={selectedScenario.scenario.id} label={`${selectedScenario.code} ${selectedScenario.scenario.name}`} refreshKey={refreshKey} />
              </Suspense>
            </ErrorBoundary>
          </LazySection>
        )}
        <LazySection id={SUMMARY_IDS.details} label="Scenario details" minHeight={64}>
          <ScenarioDetails scenarios={full.scenarios} selectedId={selectedId} onSelect={setSelected} />
        </LazySection>
        {/* 3 · Voltage, then loading of all equipment across the scenarios */}
        {buses.length > 0 && (
          <LazySection id={SUMMARY_IDS.voltage} label="Voltage" minHeight={120}>
            <VoltageMatrix buses={buses} scenarios={full.scenarios} selectedId={selectedId} onSelect={setSelected} />
          </LazySection>
        )}
        <LazySection id={SUMMARY_IDS.heatmap} label="Equipment × scenario" minHeight={200}>
          <div className="grid gap-3">
            <EquipmentFilter value={kind} onChange={setKind} counts={kindCounts} />
            <LineScenarioHeatmap lines={analysis.lines} scenarios={analysis.scenarios} selectedId={selectedId} onSelect={setSelected} />
          </div>
        </LazySection>
        {/* 4 · Comparison across the scenarios */}
        <LazySection id={SUMMARY_IDS.charts} label="Comparison" minHeight={200}>
          <div id={SUMMARY_IDS.charts}>
            <ErrorBoundary label="Evaluation charts">
              <Suspense fallback={<div className="ab-empty" aria-busy>Loading charts …</div>}>
                <AcrossCharts lines={analysis.lines} scenarios={analysis.scenarios} periodHours={periodHours} hasLodf={data!.has_lodf} />
              </Suspense>
            </ErrorBoundary>
          </div>
        </LazySection>
        <LazySection id={SUMMARY_IDS.radar} label="Scenario comparison · radar" minHeight={120}>
          <ErrorBoundary label="Scenario radar plot">
            <Suspense fallback={<div className="ab-empty" aria-busy>Loading radar plot …</div>}>
              <ScenarioRadar scenarios={analysis.scenarios} selectedId={selectedId} onSelect={setSelected} />
            </Suspense>
          </ErrorBoundary>
        </LazySection>
        {/* 5 · Reference: every number */}
        <LazySection id={SUMMARY_IDS.table} label="Detail table" minHeight={64}>
          <LineSummaryTable lines={analysis.lines} scenarios={analysis.scenarios} hasLodf={data!.has_lodf} periodHours={periodHours} />
        </LazySection>
      </div>
    </HelpContext.Provider>
  );
}
