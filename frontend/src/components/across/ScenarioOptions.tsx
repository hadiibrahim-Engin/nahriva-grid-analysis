import { useMemo, useState } from 'react';
import { useAcrossData } from '../../hooks/useAcrossData';
import { scenarioCode } from '../../util/acrossScenarios';
import { isVoltageKind } from '../../util/acrossSelection';
import { equipmentKind, EQUIPMENT_MARK } from '../../util/freischaltung';
import type { DynamicChartConfig } from '../../util/dynamicCharts';

const TOP_OPTIONS = [5, 8, 12, 20, 30] as const;
type Equipment = NonNullable<DynamicChartConfig['equipment']>;
const EQUIPMENT_OPTIONS: { id: Equipment; label: string }[] = [
  { id: 'all', label: 'Alle Betriebsmittel' },
  { id: 'line', label: 'Leitungen' },
  { id: 'transformer', label: 'Transformatoren' },
];

export type ScenarioConfigPatch = Pick<DynamicChartConfig, 'topN' | 'equipment' | 'elementMode' | 'elementIds' | 'scenarioIds'>;

/**
 * Options of the scenario evaluation charts: automatic top N or exactly the chosen equipment
 * (branches, or busbars for the voltage charts), and optionally only some scenarios.
 */
export default function ScenarioOptions({ kind, config, onChange, compact = false }: {
  kind: string;
  config: ScenarioConfigPatch;
  onChange: (patch: Partial<ScenarioConfigPatch>) => void;
  compact?: boolean;
}) {
  const bus = isVoltageKind(kind);
  const { data } = useAcrossData(0);
  const [query, setQuery] = useState('');
  const mode = config.elementMode ?? 'auto';
  const topN = config.topN ?? 12;
  const equipment = config.equipment ?? 'all';
  const chosen = useMemo(() => new Set(config.elementIds ?? []), [config.elementIds]);
  const chosenScenarios = useMemo(() => new Set(config.scenarioIds ?? []), [config.scenarioIds]);

  const items = useMemo(() => {
    const all = bus ? (data?.buses ?? []) : (data?.lines ?? []);
    return all
      .filter((item) => bus || equipment === 'all' || equipmentKind(item.type) === equipment)
      .filter((item) => !query.trim() || item.name.toLocaleLowerCase('de').includes(query.trim().toLocaleLowerCase('de')))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }, [data, bus, equipment, query]);

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange({ elementIds: [...next] });
  };
  const toggleScenario = (id: string) => {
    const next = new Set(chosenScenarios);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange({ scenarioIds: [...next] });
  };
  const label = compact ? 'text-[10px] text-[var(--grid-muted)]' : 'mb-1 block text-xs text-[var(--grid-muted)]';
  const select = compact ? 'grid-form-input grid-form-input--compact h-6 min-w-24' : 'grid-form-input w-52';

  return (
    <div className={compact ? 'space-y-2' : 'space-y-4'}>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <span className={label}>{bus ? 'Sammelschienen' : 'Betriebsmittel'}</span>
          <div className="inline-flex overflow-hidden rounded border border-[var(--grid-border)] text-xs" role="group" aria-label="Auswahlmodus">
            {([['auto', `Automatisch (Top ${topN})`], ['selected', `Ausgewählte${mode === 'selected' ? ` (${chosen.size})` : ''}`]] as const).map(([id, text]) => (
              <button key={id} type="button" aria-pressed={mode === id} onClick={() => onChange({ elementMode: id })}
                className={`px-2.5 py-1 transition-colors ${mode === id ? 'bg-[var(--grid-primary)] text-white' : 'bg-[var(--grid-control)] text-[var(--grid-text-soft)] hover:bg-[var(--grid-control-hover)]'}`}>
                {text}
              </button>
            ))}
          </div>
        </div>
        {mode === 'auto' && (
          <label>
            <span className={label}>Anzahl</span>
            <select className={select} value={topN} onChange={(e) => onChange({ topN: Number(e.target.value) })}>
              {TOP_OPTIONS.map((n) => <option key={n} value={n}>Top {n}</option>)}
            </select>
          </label>
        )}
        {!bus && (
          <label>
            <span className={label}>Typ</span>
            <select className={select} value={equipment} onChange={(e) => onChange({ equipment: e.target.value as Equipment })}>
              {EQUIPMENT_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
        )}
      </div>

      {mode === 'selected' && (
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <input type="search" className="grid-form-input grid-form-input--compact h-6 w-44" placeholder="Suchen" aria-label="Betriebsmittel suchen" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button type="button" className="text-xs text-[var(--grid-info)] hover:text-[var(--grid-primary)]" onClick={() => onChange({ elementIds: [...new Set([...chosen, ...items.map((i) => i.id)])] })}>Alle angezeigten</button>
            <button type="button" className="text-xs text-[var(--grid-info)] hover:text-[var(--grid-primary)]" onClick={() => onChange({ elementIds: [] })}>Keine</button>
            <span className="text-xs text-[var(--grid-muted)]">{chosen.size} gewählt</span>
          </div>
          <div className="max-h-44 space-y-0.5 overflow-y-auto rounded border border-[var(--grid-border)] bg-[var(--grid-subpanel)] p-1.5" role="group" aria-label="Auswahl">
            {!data && <div className="px-2 py-1 text-xs text-[var(--grid-muted)]">Wird geladen …</div>}
            {data && items.length === 0 && <div className="px-2 py-1 text-xs text-[var(--grid-muted)]">Keine Treffer.</div>}
            {items.map((item) => (
              <label key={item.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-0.5 text-xs text-[var(--grid-text-soft)] hover:bg-[var(--grid-control-hover)]">
                <input type="checkbox" className="accent-[var(--grid-primary)]" checked={chosen.has(item.id)} onChange={() => toggle(item.id)} />
                {!bus && EQUIPMENT_MARK[equipmentKind(item.type)] && <span className="ab-type">{EQUIPMENT_MARK[equipmentKind(item.type)]}</span>}
                <span className="truncate">{item.name}</span>
              </label>
            ))}
          </div>
          {chosen.size === 0 && <p className="mt-1 text-xs text-[var(--grid-warning)]">Bitte mindestens ein Element wählen.</p>}
        </div>
      )}

      {(data?.scenarios.length ?? 0) > 1 && (
        <div>
          <span className={label}>Szenarien {chosenScenarios.size === 0 ? '(alle)' : `(${chosenScenarios.size})`}</span>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Szenarien">
            <button type="button" className="ab-chip" aria-pressed={chosenScenarios.size === 0} onClick={() => onChange({ scenarioIds: [] })}>Alle</button>
            {data!.scenarios.map((scenario, index) => (
              <button key={scenario.id} type="button" className="ab-chip" aria-pressed={chosenScenarios.has(scenario.id)} title={scenario.name} onClick={() => toggleScenario(scenario.id)}>
                {scenarioCode(index)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
