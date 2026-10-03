import type { ReactNode } from 'react';
import { bandOf } from '../../config/loadingBands';
import { SUMMARY_IDS, fmtLodf, fmtPct, fmtPp, type ScenarioStats } from '../../util/acrossScenarios';
import { ScenarioTag, SectionCard } from './shared';

const time = (value: number | null) =>
  value === null ? '–' : new Date(value * 1000).toLocaleString('de-DE', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'short' });

const duration = (start: number | null, end: number | null) => {
  if (start === null || end === null || end < start) return '–';
  const hours = (end - start) / 3600;
  return hours >= 48 ? `${(hours / 24).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Tage` : `${hours.toLocaleString('de-DE', { maximumFractionDigits: 1 })} h`;
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <tr><th scope="row">{label}</th><td>{children}</td></tr>;
}

interface Props {
  scenarios: ScenarioStats[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function ScenarioDetails({ scenarios, selectedId, onSelect }: Props) {
  const current = scenarios.find((s) => s.scenario.id === selectedId) ?? scenarios[0];
  if (!current) return null;
  const { scenario } = current;
  const equipment = scenario.outages.map((o) => o.equipment_name).filter((n): n is string => !!n);
  const maxBand = current.maxValue === null ? null : bandOf(current.maxValue).id;
  return (
    <SectionCard
      collapsible
      defaultOpen={false}
      id={SUMMARY_IDS.details}
      title="Szenariodetails"
      summary={`${current.code} · ${scenario.name} – Kennzahlen und Freischaltungen. Zum Aufklappen klicken.`}
      hint="Kennzahlen des gewählten Szenarios über alle Leitungen in Betrieb."
      actions={
        <div className="ab-chips" role="group" aria-label="Szenario wählen">
          {scenarios.map((s) => (
            <button key={s.scenario.id} type="button" className="ab-chip" aria-pressed={s.scenario.id === current.scenario.id} title={s.scenario.name} onClick={() => onSelect(s.scenario.id)}>
              {s.code}
            </button>
          ))}
        </div>
      }
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <table className="ab-kv" aria-label="Kennzahlen des Szenarios">
          <tbody>
            <Row label="Szenario"><ScenarioTag code={current.code} scenario={scenario} /> <span className="ab-kv__sub">{scenario.name}</span></Row>
            <Row label="Freigeschaltetes Element">{equipment.length > 0 ? equipment.join(', ') : '–'}</Row>
            <Row label="Max Loading">
              {current.maxValue === null ? '–' : <strong className={`ab-text--${maxBand}`}>{fmtPct(current.maxValue)}</strong>}
            </Row>
            <Row label="Kritischste Leitung">{current.maxLine?.name ?? '–'}</Row>
            <Row label="Lines > 100 %">{current.n100}</Row>
            <Row label="Lines > 110 %">{current.n110}</Row>
            <Row label="Lines > 120 %">{current.n120}</Row>
            <Row label="Max Δ Loading">
              {current.maxDelta === null ? '–' : <>{fmtPp(current.maxDelta)}<span className="ab-kv__sub">{current.maxDeltaLine?.name}</span></>}
            </Row>
            <Row label="Max |LODF|">
              {current.maxAbsLodf === null ? <span className="ab-kv__sub" style={{ marginLeft: 0 }}>nicht berechnet</span> : <>{fmtLodf(current.maxAbsLodf)}<span className="ab-kv__sub">{current.maxLodfLine?.name}</span></>}
            </Row>
            <Row label="Leitungen in Betrieb">{current.total}</Row>
          </tbody>
        </table>
        <div className="min-w-0">
          <div className="ab-scroll">
            <table className="ab-table" aria-label="Freischaltungen des Szenarios">
              <thead>
                <tr><th scope="col">Ausfall</th><th scope="col">Betriebsmittel</th><th scope="col">Beginn (UTC)</th><th scope="col">Ende (UTC)</th><th scope="col">Dauer</th></tr>
              </thead>
              <tbody>
                {scenario.outages.length === 0 && <tr><td colSpan={5}>Keine Ausfalldaten gespeichert.</td></tr>}
                {scenario.outages.map((o) => (
                  <tr key={o.id}>
                    <td>{o.name}</td>
                    <td>{o.equipment_name ?? '–'}</td>
                    <td>{time(o.start)}</td>
                    <td>{time(o.end)}</td>
                    <td>{duration(o.start, o.end)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
