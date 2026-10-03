import { useHelp } from './help';
import { EQUIPMENT_PLURAL, type EquipmentKind } from '../../util/freischaltung';

export type EquipmentFilterValue = 'all' | EquipmentKind;

/** Restricts the displayed branch equipment by kind. The verdict always uses all equipment. */
export default function EquipmentFilter({ value, onChange, counts }: {
  value: EquipmentFilterValue;
  onChange: (value: EquipmentFilterValue) => void;
  counts: Record<EquipmentKind, number>;
}) {
  const help = useHelp();
  const kinds = (Object.keys(counts) as EquipmentKind[]).filter((kind) => counts[kind] > 0);
  const total = kinds.reduce((sum, kind) => sum + counts[kind], 0);
  if (kinds.length < 2) return null;
  return (
    <div className="ab-filter" role="group" aria-label="Betriebsmittel filtern">
      <span className="ab-filter__label">Betriebsmittel</span>
      <button type="button" className="ab-chip" aria-pressed={value === 'all'} onClick={() => onChange('all')}>Alle {total}</button>
      {kinds.map((kind) => (
        <button key={kind} type="button" className="ab-chip" aria-pressed={value === kind} onClick={() => onChange(kind)}>
          {EQUIPMENT_PLURAL[kind]} {counts[kind]}
        </button>
      ))}
      {help && <span className="ab-filter__note">Die Freigabe-Bewertung berücksichtigt immer alle Betriebsmittel und Sammelschienen.</span>}
    </div>
  );
}
