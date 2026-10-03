import type { DynamicChartConfig } from '../../util/dynamicCharts';

const TOP_OPTIONS = [5, 8, 12, 20, 30] as const;
const EQUIPMENT_OPTIONS: { id: NonNullable<DynamicChartConfig['equipment']>; label: string }[] = [
  { id: 'all', label: 'Alle Betriebsmittel' },
  { id: 'line', label: 'Leitungen' },
  { id: 'transformer', label: 'Transformatoren' },
];

/** The two options of the scenario evaluation charts: how many items, and which equipment kind. */
export default function ScenarioOptions({ topN, equipment, onChange, compact = false }: {
  topN: number;
  equipment: NonNullable<DynamicChartConfig['equipment']>;
  onChange: (next: { topN: number; equipment: NonNullable<DynamicChartConfig['equipment']> }) => void;
  compact?: boolean;
}) {
  const field = compact ? 'flex items-center gap-1 text-[9px] text-[var(--grid-muted)]' : 'block';
  const label = compact ? '' : 'mb-1 block text-xs text-[var(--grid-muted)]';
  const control = compact ? 'grid-form-input grid-form-input--compact h-5 min-w-20' : 'grid-form-input w-48';
  return (
    <>
      <label className={field}>
        <span className={label}>Anzahl</span>
        <select className={control} value={topN} onChange={(e) => onChange({ topN: Number(e.target.value), equipment })}>
          {TOP_OPTIONS.map((n) => <option key={n} value={n}>Top {n}</option>)}
        </select>
      </label>
      <label className={field}>
        <span className={label}>Betriebsmittel</span>
        <select className={control} value={equipment} onChange={(e) => onChange({ topN, equipment: e.target.value as NonNullable<DynamicChartConfig['equipment']> })}>
          {EQUIPMENT_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </label>
    </>
  );
}
