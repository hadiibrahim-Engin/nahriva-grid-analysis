import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import { SectionCard } from './across/shared';
import { isSynthetic, provenancePeriod, resultContexts, type ResultProvenance, type ResultScenario } from '../util/resultProvenance';
interface Job { id: string; status: string; name?: string | null; message?: string }
interface Overview { catalog: ResultProvenance | null; scenarios: ResultScenario[]; database_path: string; jobs?: Job[]; }
export default function OutageManagement({ onResultsChanged }: { onResultsChanged: () => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const callback = useRef(onResultsChanged);
  const scenarioIds = useRef('');
  useEffect(() => { callback.current = onResultsChanged; }, [onResultsChanged]);
  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const { data } = await api.get<Overview>('/outage-management');
        if (!active) return;
        setOverview(data); setError('');
        const ids = data.scenarios.map(s => s.id).join(',');
        if (ids !== scenarioIds.current) { scenarioIds.current = ids; callback.current(); }
      } catch { if (active) setError('Ergebnisdatenbank konnte nicht geladen werden.'); }
    }
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const catalog = overview?.catalog;
  const contexts = resultContexts(overview?.scenarios ?? [], catalog ?? null);
  const first = contexts[0]?.provenance;
  const summary = contexts.length
    ? [`${overview?.scenarios.length ?? 0} Szenarien`, first?.project, first?.study_case].filter(Boolean).join(' · ')
    : 'Noch keine Ergebnisse';
  const running = overview?.jobs?.find((job) => job.status === 'running' || job.status === 'queued');
  return <>
    {running && (
      <div className="ab-progress" role="status" aria-live="polite">
        <span className="ab-live" aria-hidden />
        PowerFactory berechnet{running.name ? `: ${running.name}` : ''}
      </div>
    )}
  <SectionCard title="Outage Management" defaultOpen={false} summary={summary}>
    <p className="text-xs text-[var(--grid-muted)]">{contexts.length ? `${overview?.scenarios.length ?? 0} gespeicherte Freischaltszenarien · ${overview?.scenarios.length ? 'Herkunft der gespeicherten Ergebnisse' : 'Synchronisierter Berechnungskontext · noch keine Ergebnisse'}` : 'Noch keine Ergebnisse. Das PowerFactory-Skript startet die Berechnung und dieses Dashboard.'}</p>
    {contexts.map(({ provenance: p, count, lastResult }, index) => {
      const synthetic = isSynthetic(p);
      const fields = [
        { label: 'Modell / Projekt', value: p.project || 'Nicht erfasst', path: p.project_path },
        { label: 'Studie / Study Case', value: p.study_case || 'Nicht erfasst', path: p.study_case_path },
        { label: 'PowerFactory-Version', value: synthetic ? 'Nicht verwendet · synthetische Daten' : p.powerfactory_version || 'Nicht erfasst' },
        { label: 'Datenquelle', value: synthetic ? 'Dummy QDS · synthetische Testdaten' : p.data_source || 'Nicht erfasst' },
        { label: 'Simulationszeitraum', value: provenancePeriod(p.period) },
        ...(p.sample_interval_seconds ? [{ label: 'Zeitauflösung', value: `${p.sample_interval_seconds / 60} Minuten` }] : []),
        ...(p.qds_command ? [{ label: 'QDS-Berechnung', value: p.qds_command.name, path: p.qds_command.path }] : []),
        ...(p.operational_scenario ? [{ label: 'Betriebsszenario', value: p.operational_scenario.name, path: p.operational_scenario.path }] : []),
        ...(p.networks?.length ? [{ label: 'Aktive Netze', value: p.networks.map(grid => grid.name).join(', '), path: p.networks.map(grid => grid.path).join('\n') }] : []),
        ...(p.grid_name_filter ? [{ label: 'Netzfilter', value: p.grid_name_filter }] : []),
      ];
      return <div key={index} className="mt-3 border-t border-[var(--grid-border)] pt-3">
        {contexts.length > 1 && <p className="mb-2 text-xs font-semibold">Berechnungskontext {index + 1} · {count} Szenarien</p>}
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
          {fields.map(field => <div key={field.label} className="min-w-0">
            <dt className="text-[11px] text-[var(--grid-muted)]">{field.label}</dt>
            <dd className="mt-0.5 break-words text-xs font-medium" title={field.path}>{field.value}</dd>
          </div>)}
        </dl>
        {lastResult && <p className="mt-3 text-[11px] text-[var(--grid-muted)]">Letztes gespeichertes Ergebnis: {new Date(lastResult).toLocaleString('de-DE')}</p>}
        {synthetic && <p className="mt-2 text-xs text-[var(--grid-muted)]">Synthetisches Demo-Modell für den Mac-Test · keine PowerFactory-Berechnung.</p>}
      </div>;
    })}
    {overview?.database_path && <p className="mt-3 break-all text-[11px] text-[var(--grid-muted)]" title="Aktive Ergebnisdatenbank">Datenbank: {overview.database_path}</p>}
    {error && <p role="alert" className="mt-2 text-sm text-red-400">{error}</p>}
  </SectionCard>
  </>;
}
