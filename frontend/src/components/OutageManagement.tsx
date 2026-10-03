import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
interface Outage { id: string; name: string; equipment_name: string; start: number | null; end: number | null; }
interface Scenario { id: string; name: string; outage_ids: string[]; runs: { run_id: string; kind: string }[]; }
interface Overview { catalog: { project: string; study_case: string; outages: Outage[]; dummy_qds_version?: number; } | null; scenarios: Scenario[]; database_path: string; }
const timeLabel = (value: number | null) => value === null ? '–' : new Date(value * 1000).toLocaleString('de-DE', { timeZone: 'UTC' });
export default function OutageManagement({ onResultsChanged }: { onResultsChanged: () => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
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
  return <div className="rounded-lg border border-[var(--grid-border)] bg-[var(--grid-surface)] p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-sm font-semibold text-[var(--grid-text)]">Outage Management</h2><p className="mt-1 text-xs text-[var(--grid-muted)]">{catalog ? `${catalog.project} / ${catalog.study_case} · ${overview?.scenarios.length ?? 0} gespeicherte Freischaltszenarien` : 'Noch keine Ergebnisse. Das PowerFactory-Skript startet die Berechnung und dieses Dashboard.'}</p></div>
      <button type="button" onClick={() => setExpanded(v => !v)} aria-expanded={expanded} className="grid-form-trigger !w-auto">{expanded ? 'Details ausblenden' : 'Szenariodetails'}</button>
    </div>
    {catalog?.dummy_qds_version && <p className="mt-2 text-xs text-amber-400">Dummy QDS · synthetische Testdaten für den Mac-Test.</p>}
    {error && <p role="alert" className="mt-2 text-sm text-red-400">{error}</p>}
    {expanded && <div className="mt-4 space-y-3 text-xs text-[var(--grid-muted)]">
      <p className="break-all">Datenbank: {overview?.database_path}</p>
      {overview?.scenarios.map(scenario => <div key={scenario.id} className="border-t border-[var(--grid-border)] pt-2"><strong className="text-[var(--grid-text)]">{scenario.name}</strong><p>{scenario.runs.map(r => r.kind).join(' / ')} · vollständige Simulationsreihen</p>{catalog?.outages.filter(o => scenario.outage_ids.includes(o.id)).map(o => <p key={o.id}>{o.name} · {o.equipment_name} · {timeLabel(o.start)} – {timeLabel(o.end)} UTC</p>)}</div>)}
      <p>Oben unter „Szenario“ REF und OUTAGE auswählen und dieselben Betriebsmittel als Zeitreihen hinzufügen.</p>
    </div>}
  </div>;
}
