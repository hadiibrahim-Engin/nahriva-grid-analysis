import type { CSSProperties } from 'react';
import { ANALYSIS, bandOf, type BandId } from '../../config/loadingBands';
import { VERDICTS, type Verdict } from '../../config/assessment';
import { verdictCounts, type Assessment } from '../../util/freischaltung';
import {
  fmtHours,
  fmtLodf,
  fmtNum,
  fmtPeriod,
  fmtPp,
  fmtShare,
  type AcrossKpis,
  type ScenarioStats,
} from '../../util/acrossScenarios';

interface Props {
  kpis: AcrossKpis;
  scenarios: ScenarioStats[];
  assessments: Map<string, Assessment>;
}

function Kpi({ label, value, unit, sub, tone, title }: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  tone?: BandId;
  title?: string;
}) {
  return (
    <div className="ab-kpi" title={title}>
      <div className="ab-kpi__label">{label}</div>
      <div className={`ab-kpi__value${tone ? ` ab-text--${tone}` : ''}`}>
        {value}{unit && <span className="ab-kpi__unit">{unit}</span>}
      </div>
      {sub !== undefined && <div className={`ab-kpi__sub${sub === '–' ? ' ab-kpi__sub--muted' : ''}`}>{sub}</div>}
    </div>
  );
}

export default function AcrossKpis({ kpis, scenarios, assessments }: Props) {
  const counts = verdictCounts(assessments.values());
  const byId = new Map<string, ScenarioStats>(scenarios.map((s) => [s.scenario.id, s]));
  const where = (id: string | null) => {
    const stats = id ? byId.get(id) : undefined;
    return stats ? stats.code : '';
  };
  const place = (line: { name: string }, scenarioId: string | null) =>
    [line.name, where(scenarioId)].filter(Boolean).join(' · ');
  const n = kpis.scenarioCount;
  const share = n > 0 ? Math.round((kpis.scenariosOverloaded / n) * 100) : 0;
  const max = kpis.maxLoading;
  const critical: ScenarioStats | null = kpis.criticalScenario;

  return (
    <div className="ab-kpis" role="list" aria-label="Zusammenfassung über alle Szenarien">
      <div className="ab-kpi" title="Freigabe-Bewertung aller Szenarien nach den Kriterien in config/assessment.ts">
        <div className="ab-kpi__label">Freigabe-Bewertung</div>
        <div className="ab-vcounts">
          {(['permissible', 'conditional', 'not-permissible'] as Verdict[]).map((v) => (
            <span key={v} className={`ab-vcount ab-verdict--${v}`} title={`${VERDICTS[v].label}: ${VERDICTS[v].description}`} style={{ '--v': `var(--ab-v-${v})` } as CSSProperties}>
              <span aria-hidden>{VERDICTS[v].glyph}</span> {counts[v]}
            </span>
          ))}
        </div>
        <div className="ab-kpi__sub">{n} Szenarien{kpis.periodHours > 0 ? ` · Zeitraum ${fmtPeriod(kpis.periodHours)}` : ''}</div>
      </div>
      <Kpi
        label="Szenarien mit Überlastung"
        value={`${kpis.scenariosOverloaded} / ${n}`}
        tone={kpis.scenariosOverloaded > 0 ? 'light' : undefined}
        sub={`${share} % der Szenarien > 100 %`}
      />
      <Kpi
        label="Betriebsmittel > 100 %"
        value={String(kpis.linesOverloaded)}
        tone={kpis.linesOverloaded > 0 ? 'light' : undefined}
        sub={kpis.linesOverloaded > 0 ? `${kpis.linesRecurring} davon in ≥ ${ANALYSIS.recurringMinScenarios} Szenarien` : 'in keinem Szenario'}
        title="Leitungen, die in mindestens einem Szenario über 100 % liegen; davon wiederkehrend in mehreren Szenarien"
      />
      <Kpi
        label="Längste Überlastung"
        value={kpis.longestOverload ? fmtHours(kpis.longestOverload.value) : '–'}
        tone={kpis.longestOverload ? 'clear' : undefined}
        sub={kpis.longestOverload
          ? `${fmtShare(kpis.longestOverload.share)} des Zeitraums · ${place(kpis.longestOverload.line, kpis.longestOverload.scenarioId)}`
          : 'keine Überlastung'}
        title={kpis.longestOverload ? `Overload Rate ${fmtShare(kpis.longestOverload.share)} · ${place(kpis.longestOverload.line, kpis.longestOverload.scenarioId)}` : undefined}
      />
      <Kpi
        label="Max Loading"
        value={max ? fmtNum(max.value) : '–'}
        unit={max ? '%' : undefined}
        tone={max ? bandOf(max.value).id : undefined}
        sub={max ? place(max.line, max.scenarioId) : '–'}
        title={max ? place(max.line, max.scenarioId) : undefined}
      />
      <Kpi
        label="Größte Änderung ggü. Base"
        value={kpis.maxChange ? fmtPp(kpis.maxChange.value) : '–'}
        sub={kpis.maxChange ? place(kpis.maxChange.line, kpis.maxChange.scenarioId) : '–'}
        title={kpis.maxChange ? place(kpis.maxChange.line, kpis.maxChange.scenarioId) : undefined}
      />
      <Kpi
        label="Höchster |LODF|"
        value={kpis.maxLodf ? fmtLodf(kpis.maxLodf.value) : '–'}
        sub={kpis.maxLodf ? place(kpis.maxLodf.line, kpis.maxLodf.scenarioId) : 'noch nicht berechnet'}
        title={kpis.maxLodf ? place(kpis.maxLodf.line, kpis.maxLodf.scenarioId) : undefined}
      />
      <Kpi
        label="Kritischstes Szenario"
        value={critical ? critical.code : '–'}
        tone={critical ? bandOf(critical.maxValue ?? 0).id : undefined}
        sub={critical
          ? `${critical.scenario.name} · ${critical.n100} Betriebsmittel > 100 %`
          : 'keine Überlastung'}
        title={critical?.scenario.name}
      />
    </div>
  );
}
