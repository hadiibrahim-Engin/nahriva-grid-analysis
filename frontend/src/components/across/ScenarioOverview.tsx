import { useMemo, useState, type CSSProperties } from 'react';
import { ANALYSIS, BAND_ORDER, LOADING_BANDS, bandOf, bandVar } from '../../config/loadingBands';
import {
  compareScenarioCriticality,
  fmtHours,
  fmtPct,
  fmtLodf,
  fmtPp,
  fmtPeriod,
  fmtShare,
  type ScenarioStats,
  SUMMARY_IDS,
} from '../../util/acrossScenarios';
import { compareVerdict, type Assessment } from '../../util/freischaltung';
import { BandLegend, ScenarioTag, SectionCard } from './shared';
import VerdictBadge from './VerdictBadge';

interface Props {
  scenarios: ScenarioStats[];
  assessments: Map<string, Assessment>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  periodHours: number;
  /** [start, end] in epoch seconds, when the database knows it. */
  period: [number, number] | null | undefined;
}

const dayLabel = (epoch: number) =>
  new Date(epoch * 1000).toLocaleDateString('de-DE', { timeZone: 'UTC', day: '2-digit', month: '2-digit' });
const stamp = (epoch: number | null) =>
  epoch === null ? '–' : new Date(epoch * 1000).toLocaleString('de-DE', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'short' }) + ' UTC';

/**
 * One row per scenario: what is switched off, when (timeline over the simulation
 * period), how the lines distribute over the loading bands, and the key figures.
 */
export default function ScenarioOverview({ scenarios, assessments, selectedId, onSelect, periodHours, period }: Props) {
  const [order, setOrder] = useState<'critical' | 'original'>('critical');
  const rows = useMemo(
    () => (order === 'critical'
      ? [...scenarios].sort((a, b) => {
          const x = assessments.get(a.scenario.id);
          const y = assessments.get(b.scenario.id);
          return (x && y ? compareVerdict(x, y) : 0) || compareScenarioCriticality(a, b);
        })
      : scenarios),
    [scenarios, order, assessments],
  );

  const axis = useMemo(() => {
    const windows = scenarios.flatMap((s) => s.scenario.outages)
      .filter((o): o is typeof o & { start: number; end: number } => o.start !== null && o.end !== null);
    const start = period?.[0] ?? (windows.length ? Math.min(...windows.map((o) => o.start)) : 0);
    const seconds = periodHours > 0 ? periodHours * 3600
      : windows.length ? Math.max(...windows.map((o) => o.end)) - start : 0;
    const days = Math.max(1, Math.round(seconds / 86400));
    const every = Math.max(1, Math.ceil(days / 8));
    const ticks = Array.from({ length: Math.floor(days / every) + 1 }, (_, i) => i * every).filter((d) => d < days || d === 0);
    return { start, seconds, days, ticks };
  }, [scenarios, period, periodHours]);

  const pos = (epoch: number) => Math.min(Math.max(((epoch - axis.start) / axis.seconds) * 100, 0), 100);
  const dayWidth = axis.seconds > 0 ? `${(86400 / axis.seconds) * 100}%` : '100%';

  return (
    <SectionCard
      id={SUMMARY_IDS.overview}
      title="Freigabe-Bewertung der Szenarien"
      hint={`Freigabe-Bewertung je Szenario mit Begründung, was freigeschaltet ist und wann (Simulationszeitraum ${Number.isFinite(periodHours) ? fmtPeriod(periodHours) : 'nicht bekannt'}), und wie sich die Betriebsmittel auf die Auslastungsbereiche verteilen. Zeile wählen für Verlauf und Details.`}
      actions={
        <label className="ab-toggle">
          Sortierung
          <select className="ab-control" value={order} onChange={(e) => setOrder(e.target.value as 'critical' | 'original')}>
            <option value="critical">Kritischste zuerst</option>
            <option value="original">Reihenfolge</option>
          </select>
        </label>
      }
    >
      <div className="mb-2"><BandLegend /></div>
      <div className="ab-scroll ab-table-wide">
        <table className="ab-table ab-scenario-table" aria-label="Szenarien mit Freischaltungen und Kennzahlen">
        <colgroup><col style={{ width: '24%' }} /><col style={{ width: '28%' }} /><col style={{ width: '24%' }} /><col style={{ width: '24%' }} /></colgroup>
        <thead><tr>
          <th scope="col">Szenario · enthält</th>
          <th scope="col"><span className="block mb-2">Ausfallfenster (UTC)</span><div className="ab-axis">
            {axis.seconds > 0 && axis.ticks.map((d) => (
              <span key={d} style={{ left: `${((d * 86400) / axis.seconds) * 100}%` }}>{dayLabel(axis.start + d * 86400)}</span>
            ))}
          </div></th>
          <th scope="col">Betriebsmittel je Auslastung</th>
          <th scope="col">Bewertung und Kennzahlen</th>
        </tr></thead><tbody>
        {rows.map((s) => {
          const band = s.maxValue === null ? 'ok' : bandOf(s.maxValue).id;
          const assess = assessments.get(s.scenario.id);
          const equipment = [...new Set(s.scenario.outages.map((o) => o.equipment_name ?? o.name))];
          return (
            <tr key={s.scenario.id} aria-selected={selectedId === s.scenario.id}>
              <td>
                <button type="button" className="ab-scenario-select" aria-pressed={selectedId === s.scenario.id} onClick={() => onSelect(s.scenario.id)}>
                <span className="ab-ov__title" title={s.scenario.name}><ScenarioTag code={s.code} scenario={s.scenario} /><span>{s.scenario.name}</span></span>
                <span className="ab-ov__contents">
                  {equipment.length === 0 && <span className="ab-sub">keine Freischaltung gespeichert</span>}
                  {equipment.map((name) => <span key={name} className="ab-tag" title={`Freigeschaltet: ${name}`}>{name}</span>)}
                </span>
                </button>
              </td>
              <td><span className="ab-timeline" style={{ '--day': dayWidth, '--c': bandVar(band) } as CSSProperties} role="img"
                aria-label={`Ausfallfenster ${s.scenario.outages.map((o) => `${o.equipment_name ?? o.name}: ${stamp(o.start)} bis ${stamp(o.end)}`).join('; ')}`}>
                {axis.seconds > 0 && s.scenario.outages.map((o) => o.start === null || o.end === null ? null : (
                  <span
                    key={o.id}
                    className="ab-timeline__win"
                    style={{ left: `${pos(o.start)}%`, width: `${Math.max(pos(o.end) - pos(o.start), 0)}%` }}
                    title={`${o.equipment_name ?? o.name}\n${stamp(o.start)} – ${stamp(o.end)}`}
                  />
                ))}
              </span></td>
              <td><span
                className="ab-stack"
                role="img"
                aria-label={LOADING_BANDS.map((b) => `${b.label}: ${s.counts[b.id]}`).join(', ')}
              >
                {BAND_ORDER.map((id) => {
                  const count = s.counts[id];
                  if (count === 0) return null;
                  const pct = (count / s.total) * 100;
                  const meta = LOADING_BANDS.find((b) => b.id === id)!;
                  return (
                    <span key={id} className={`ab-stack__seg ab-fill--${id} ab-ink--${id}`} style={{ width: `${pct}%` }}
                      title={`${meta.label} (${meta.range}): ${count} von ${s.total} Betriebsmitteln`}>
                      {pct >= 8 ? count : ''}
                    </span>
                  );
                })}
              </span></td>
              <td title={[
                s.longestOverloadHours > 0 ? `Längste Überlastung ${fmtHours(s.longestOverloadHours)} (${fmtShare(periodHours > 0 ? s.longestOverloadHours / periodHours : 0)} des Zeitraums)` : 'keine Überlastung',
                `Max Δ ${fmtPp(s.maxDelta)} · |LODF| ${fmtLodf(s.maxAbsLodf)}`,
                `wirkt auf ${s.affected} Betriebsmittel (≥ ${ANALYSIS.affectedDeltaPp} pp)`,
              ].join('\n')}><span className="ab-ov__facts">
                {assess && <span><VerdictBadge verdict={assess.verdict} /></span>}
                {assess?.reasons.slice(0, 2).map((reason) => <span key={reason} className="ab-ov__reason">{reason}</span>)}
                <span>Max <strong className={`ab-text--${band}`}>{fmtPct(s.maxValue)}</strong>{s.maxLine ? ` · ${s.maxLine.name}` : ''}</span>
              </span></td>
            </tr>
          );
        })}
        </tbody></table>
      </div>
    </SectionCard>
  );
}
