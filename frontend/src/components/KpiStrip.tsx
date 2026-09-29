import type { Analysis } from "../api/types";
import { formatChartNumber as fmt } from "./charts/format";

export default function KpiStrip({ data }: { data: Analysis }) {
  const { stats, metric, comparison } = data;
  return (
    <section className="kpi-strip" aria-label="Kennzahlen">
      <article>
        <span>Mittelwert · {metric.unit}</span>
        <strong>{fmt(stats.mean)}</strong>
        <small>
          {comparison
            ? `${fmt(comparison.mean_delta)} ${metric.unit} Δ · ${comparison.matched_count.toLocaleString("de-DE")} gepaarte Werte`
            : `${stats.count.toLocaleString("de-DE")} gültige Messwerte`}
        </small>
      </article>
      <article>
        <span>Maximum · {metric.unit}</span>
        <strong>{fmt(stats.max)}</strong>
        <small>
          Minimum {fmt(stats.min)} {metric.unit}
        </small>
      </article>
      <article>
        <span>95. Perzentil · {metric.unit}</span>
        <strong>{fmt(stats.p95)}</strong>
        <small>
          Standardabweichung {fmt(stats.std_dev)} {metric.unit}
        </small>
      </article>
      <article className={stats.violations ? "warning-kpi" : ""}>
        <span>Grenzwertverletzungen</span>
        <strong>
          {metric.lower === null && metric.upper === null
            ? "—"
            : stats.violations.toLocaleString("de-DE")}
        </strong>
        <small>
          {metric.lower === null && metric.upper === null
            ? "Keine Grenzwerte hinterlegt"
            : `${fmt(stats.count ? (100 * stats.violations) / stats.count : 0)} % der gültigen Messwerte`}
        </small>
      </article>
    </section>
  );
}
