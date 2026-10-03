import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import api from '../../api/client';
import { SUMMARY_IDS, analyse, compareScenarioCriticality, summarySections, type AcrossData, type SummarySection } from '../../util/acrossScenarios';
import { assessScenario, compareVerdict, equipmentKind, type EquipmentKind } from '../../util/freischaltung';
import ErrorBoundary from '../ErrorBoundary';
import EquipmentFilter, { type EquipmentFilterValue } from './EquipmentFilter';
import AcrossKpis from './AcrossKpis';
import LineScenarioHeatmap from './LineScenarioHeatmap';
import LineSummaryTable from './LineSummaryTable';
import ScenarioDetails from './ScenarioDetails';
import ScenarioOverview from './ScenarioOverview';
import VoltageMatrix from './VoltageMatrix';
import { SectionCard } from './shared';

const AcrossCharts = lazy(() => import('./AcrossCharts'));
const ScenarioRadar = lazy(() => import('./ScenarioRadar'));
const ScenarioProfile = lazy(() => import('./ScenarioProfile'));

/**
 * Across-scenarios evaluation. Order follows the reading path: overall state
 * first (KPIs, scenario overview), then the charts, the lines × scenarios
 * heatmap, and finally the collapsible detail table and scenario details.
 */
export default function AcrossScenarios({ refreshKey, onSectionsChange }: {
  refreshKey: number;
  /** Reports the sections currently on screen, for the navigation bar. */
  onSectionsChange?: (sections: SummarySection[]) => void;
}) {
  const [data, setData] = useState<AcrossData | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [kind, setKind] = useState<EquipmentFilterValue>('all');

  useEffect(() => {
    let active = true;
    api.get<AcrossData>('/across-scenarios')
      .then((response) => { if (active) { setData(response.data); setError(''); } })
      .catch(() => { if (active) setError('Die Auswertung über alle Szenarien konnte nicht geladen werden.'); });
    return () => { active = false; };
  }, [refreshKey]);

  const buses = useMemo(() => data?.buses ?? [], [data]);
  // The assessment parts (key figures, verdicts, profile, details) always cover all equipment ...
  const full = useMemo(() => (data ? analyse(data) : null), [data]);
  // ... the comparison parts (matrix, charts, radar, table) follow the equipment filter.
  const analysis = useMemo(() => {
    if (!data) return null;
    const lines = kind === 'all' ? data.lines : data.lines.filter((line) => equipmentKind(line.type) === kind);
    return analyse({ ...data, lines });
  }, [data, kind]);
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

  if (error) return <p role="alert" className="mt-4 text-sm text-[var(--grid-danger)]">{error}</p>;
  if (!analysis || !full || full.scenarios.length === 0) {
    return full ? (
      <p className="mt-4 text-sm text-[var(--grid-muted)]">Noch keine berechneten Szenarien für die Auswertung über alle Szenarien.</p>
    ) : null;
  }
  const periodHours = data!.period_hours;
  return (
    <div className="across-scope mt-4 grid gap-3" aria-label="Across-Scenarios-Auswertung">
      {/* 1 · Result first: key figures and the verdict per scenario, always over all equipment */}
      <SectionCard id={SUMMARY_IDS.kpis} title="Kennzahlen" summary={`${full.scenarios.length} Szenarien · ${full.lines.length} Betriebsmittel${buses.length ? ` · ${buses.length} Sammelschienen` : ''}`}>
        <AcrossKpis kpis={full.kpis} scenarios={full.scenarios} assessments={assessments} />
      </SectionCard>
      <ScenarioOverview scenarios={full.scenarios} assessments={assessments} selectedId={selectedId} onSelect={setSelected} periodHours={periodHours} period={data!.period} />
      {/* 2 · The chosen scenario in detail: when is it critical, what does it contain */}
      {selectedScenario && (
        <ErrorBoundary label="Belastungsverlauf">
          <Suspense fallback={<div className="ab-empty" aria-busy>Verlauf wird geladen …</div>}>
            <ScenarioProfile scenarioId={selectedScenario.scenario.id} label={`${selectedScenario.code} ${selectedScenario.scenario.name}`} refreshKey={refreshKey} />
          </Suspense>
        </ErrorBoundary>
      )}
      <ScenarioDetails scenarios={full.scenarios} selectedId={selectedId} onSelect={setSelected} />
      {/* 3 · Voltage, then loading of all equipment across the scenarios */}
      {buses.length > 0 && <VoltageMatrix buses={buses} scenarios={full.scenarios} selectedId={selectedId} onSelect={setSelected} />}
      <EquipmentFilter value={kind} onChange={setKind} counts={kindCounts} />
      <LineScenarioHeatmap lines={analysis.lines} scenarios={analysis.scenarios} selectedId={selectedId} onSelect={setSelected} />
      {/* 4 · Comparison across the scenarios */}
      <div id={SUMMARY_IDS.charts}>
        <ErrorBoundary label="Auswertungsdiagramme">
          <Suspense fallback={<div className="ab-empty" aria-busy>Diagramme werden geladen …</div>}>
            <AcrossCharts lines={analysis.lines} scenarios={analysis.scenarios} periodHours={periodHours} hasLodf={data!.has_lodf} />
          </Suspense>
        </ErrorBoundary>
      </div>
      <ErrorBoundary label="Szenario-Radarplot">
        <Suspense fallback={<div className="ab-empty" aria-busy>Radarplot wird geladen …</div>}>
          <ScenarioRadar scenarios={analysis.scenarios} selectedId={selectedId} onSelect={setSelected} />
        </Suspense>
      </ErrorBoundary>
      {/* 5 · Reference: every number */}
      <LineSummaryTable lines={analysis.lines} scenarios={analysis.scenarios} hasLodf={data!.has_lodf} periodHours={periodHours} />
    </div>
  );
}
