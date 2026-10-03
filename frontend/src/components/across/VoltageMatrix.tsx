import { ASSESSMENT } from '../../config/assessment';
import { SUMMARY_IDS, type AcrossBus, type ScenarioStats } from '../../util/acrossScenarios';
import { CAUSE_LABEL, busBand, voltageResult } from '../../util/outageAssessment';
import { formatVoltage as volt, isPerUnit, unitLabel } from '../../util/voltage';
import { ScenarioTag, SectionCard } from './shared';

/** Busbar × scenario: the voltage value closest to a limit, coloured by distance to the band. */
export default function VoltageMatrix({ buses, scenarios, selectedId, onSelect }: {
  buses: AcrossBus[];
  scenarios: ScenarioStats[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const withLimits = buses.filter((b) => busBand(b));
  const unit = buses.find((b) => b.unit)?.unit ?? 'p.u.';
  return (
    <SectionCard
      id={SUMMARY_IDS.voltage}
      title="Busbar voltage"
      hint={`Voltage in ${unit} in the outage window; the value closest to the band is shown (▼ lower, ▲ upper limit). ${isPerUnit(unit) ? `Band ${ASSESSMENT.voltageBandPu.lower.toLocaleString('en-GB', { minimumFractionDigits: 2 })}–${ASSESSMENT.voltageBandPu.upper.toLocaleString('en-GB', { minimumFractionDigits: 2 })} p.u. (configured centrally). Near the limit: distance < ${ASSESSMENT.voltageMarginPu.toLocaleString('en-GB')} p.u.` : 'Band: the limits saved with the results.'}`}
    >
      <ul className="ab-legend" aria-label="Voltage status" style={{ marginBottom: 8 }}>
        <li><span className="ab-swatch ab-fill--ok" /><span className="ab-legend__label">in band</span></li>
        <li><span className="ab-swatch ab-fill--high" /><span className="ab-legend__label">near the limit</span></li>
        <li><span className="ab-swatch ab-fill--severe ab-cell--caused" /><span className="ab-legend__label">Band left because of the outage</span></li>
        <li><span className="ab-swatch ab-fill--clear ab-cell--pre" /><span className="ab-legend__label">Pre-existing (already in REF)</span></li>
      </ul>
      {withLimits.length === 0 ? (
        <div className="ab-empty">No voltage limits are stored for the busbars; no violation is derived.</div>
      ) : (
        <div className="ab-scroll" style={{ padding: 4 }}>
          <table className="ab-heat" style={{ minWidth: `calc(20rem + ${scenarios.length * 5.5}rem)` }}>
            <colgroup>
              <col style={{ width: '15rem' }} />
              <col style={{ width: '5.5rem' }} />
              {scenarios.map((s) => <col key={s.scenario.id} />)}
            </colgroup>
            <thead>
              <tr>
                <th className="ab-heat__line" scope="col">Busbar</th>
                <th scope="col">Band</th>
                {scenarios.map((s) => (
                  <th key={s.scenario.id} scope="col">
                    <button type="button" className="ab-heat__colbtn" aria-pressed={selectedId === s.scenario.id} onClick={() => onSelect(s.scenario.id)} title={s.scenario.name}>
                      <ScenarioTag code={s.code} scenario={s.scenario} />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {withLimits.map((bus) => (
                <tr key={bus.id}>
                  <td className="ab-heat__line" title={bus.name}>{bus.name}</td>
                  <td className="ab-heat__cell ab-heat__cell--none" title={`Voltage band in ${unitLabel(bus.unit ?? unit)}`}>{volt(busBand(bus)?.[0], bus.unit)}–{volt(busBand(bus)?.[1], bus.unit)}</td>
                  {scenarios.map((s) => {
                    const cell = bus.cells[s.scenario.id];
                    const result = voltageResult(bus, cell);
                    if (!cell || !cell.out || result.state === 'unknown') return <td key={s.scenario.id} className="ab-heat__cell ab-heat__cell--none">–</td>;
                    const [lower, upper] = busBand(bus) ?? [null, null];
                    const lowSide = lower !== null && (upper === null || cell.out[0] - lower <= upper - cell.out[1]);
                    const shown = lowSide ? cell.out[0] : cell.out[1];
                    const cls = result.state === 'ok' ? 'ab-fill--ok ab-ink--ok'
                      : result.state === 'near' ? 'ab-fill--high ab-ink--high'
                      : result.cause === 'preexisting' ? 'ab-fill--clear ab-ink--clear ab-cell--pre'
                      : 'ab-fill--severe ab-ink--severe ab-cell--caused';
                    const tip = [
                      `${bus.name} · ${s.code} ${s.scenario.name}`,
                      `Voltage in the window: ${volt(cell.out[0], bus.unit)} – ${volt(cell.out[1], bus.unit)} ${unitLabel(bus.unit ?? unit)}`,
                      `REF in the same window: ${volt(cell.ref?.[0], bus.unit)} – ${volt(cell.ref?.[1], bus.unit)} ${unitLabel(bus.unit ?? unit)}`,
                      `Distance to the limit: ${volt(result.margin, bus.unit)} ${unitLabel(bus.unit ?? unit)}`,
                      result.cause ? CAUSE_LABEL[result.cause] : '',
                      cell.hours_outside ? `Outside the band: ${cell.hours_outside.toLocaleString('en-GB', { maximumFractionDigits: 1 })} h` : '',
                    ].filter(Boolean).join('\n');
                    return (
                      <td key={s.scenario.id} className={`ab-heat__cell ${cls}`} title={tip}>
                        {lowSide ? '▼' : '▲'} {volt(shown, bus.unit)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
