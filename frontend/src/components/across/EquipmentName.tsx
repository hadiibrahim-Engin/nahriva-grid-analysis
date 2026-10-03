import { EQUIPMENT_LABEL, EQUIPMENT_MARK, equipmentKind } from '../../util/outageAssessment';

/** A piece of equipment's name, with the small kind mark (T for transformers) in front where there is one. */
export default function EquipmentName({ type, name }: { type: string; name: string }) {
  const kind = equipmentKind(type);
  const mark = EQUIPMENT_MARK[kind];
  return (
    <>
      {mark && <span className="ab-type" aria-label={EQUIPMENT_LABEL[kind]}>{mark}</span>}
      {name}
    </>
  );
}
