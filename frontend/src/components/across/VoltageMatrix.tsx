import { ASSESSMENT } from '../../config/assessment';
import { SUMMARY_IDS, type AcrossBus, type ScenarioStats } from '../../util/acrossScenarios';
import { CAUSE_LABEL, busBand, voltageResult } from '../../util/freischaltung';
import { ScenarioTag, SectionCard } from './shared';

const isPu = (unit: string | null | undefined) => /^p\.?u\.?$/i.test((unit ?? '').trim());
const volt = (v: number | null | undefined, unit: string | null | undefined) =>
  v == null ? '–' : v.toLocaleString('de-DE', isPu(unit) ? { minimumFractionDigits: 3, maximumFractionDigits: 3 } : { minimumFractionDigits: 1, maximumFractionDigits: 1 });

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
      title="Spannungshaltung Sammelschienen"
      hint={`Spannung in ${unit} im Ausfallfenster; angezeigt wird der Wert mit dem kleineren Abstand zum Band (▼ untere, ▲ obere Grenze). ${isPu(unit) ? `Band ${ASSESSMENT.voltageBandPu.lower.toLocaleString('de-DE', { minimumFractionDigits: 2 })}–${ASSESSMENT.voltageBandPu.upper.toLocaleString('de-DE', { minimumFractionDigits: 2 })} p.u. (zentral konfiguriert). Nahe der Grenze: Abstand < ${ASSESSMENT.voltageMarginPu.toLocaleString('de-DE')} p.u.` : 'Band: die mit den Ergebnissen gespeicherten Grenzen.'}`}
    >
      <ul className="ab-legend" aria-label="Spannungsstatus" style={{ marginBottom: 8 }}>
        <li><span className="ab-swatch ab-fill--ok" /><span className="ab-legend__label">im Band</span></li>
        <li><span className="ab-swatch ab-fill--high" /><span className="ab-legend__label">nahe der Grenze</span></li>
        <li><span className="ab-swatch ab-fill--severe ab-cell--caused" /><span className="ab-legend__label">Band verlassen durch Freischaltung</span></li>
        <li><span className="ab-swatch ab-fill--clear ab-cell--pre" /><span className="ab-legend__label">Vorbelastung (schon in REF)</span></li>
      </ul>
      {withLimits.length === 0 ? (
        <div className="ab-empty">Für die Sammelschienen sind keine Spannungsgrenzen hinterlegt; es wird keine Verletzung abgeleitet.</div>
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
                <th className="ab-heat__line" scope="col">Sammelschiene</th>
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
                  <td className="ab-heat__cell ab-heat__cell--none" title={`Spannungsband in ${bus.unit ?? unit}`}>{volt(busBand(bus)?.[0], bus.unit)}–{volt(busBand(bus)?.[1], bus.unit)}</td>
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
                      `Spannung im Fenster: ${volt(cell.out[0], bus.unit)} – ${volt(cell.out[1], bus.unit)} ${bus.unit ?? unit}`,
                      `REF im selben Fenster: ${volt(cell.ref?.[0], bus.unit)} – ${volt(cell.ref?.[1], bus.unit)} ${bus.unit ?? unit}`,
                      `Abstand zur Grenze: ${volt(result.margin, bus.unit)} ${bus.unit ?? unit}`,
                      result.cause ? CAUSE_LABEL[result.cause] : '',
                      cell.hours_outside ? `Außerhalb des Bandes: ${cell.hours_outside.toLocaleString('de-DE', { maximumFractionDigits: 1 })} h` : '',
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
