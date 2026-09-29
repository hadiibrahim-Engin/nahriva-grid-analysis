import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, FilterX, Search, SlidersHorizontal } from "lucide-react";
import type { Analysis, ElementResult, Metric, Run } from "../api/types";
import { downloadCsv } from "../api/client";
import { useResource } from "../hooks/useResource";
import { filterQuery, selectionPayload } from "../util/selection";
import { ErrorState, Loading } from "../components/States";
import KpiStrip from "../components/KpiStrip";
import ElementTable from "../components/ElementTable";
import ElementDetail from "../components/ElementDetail";
const AnalysisCharts = lazy(
  () => import("../components/charts/AnalysisCharts"),
);

export default function AnalysisPage() {
  const runs = useResource<Run[]>("/analysis/runs");
  if (runs.loading) return <Loading />;
  if (runs.error)
    return <ErrorState message={runs.error} retry={runs.reload} />;
  if (!runs.data?.length)
    return (
      <section className="panel state">
        <h2>Noch keine Ergebnisse</h2>
        <p>
          Importiere einen Simulation Run. Die Anleitung und das JSON-Schema
          liegen unter „Datenquellen“.
        </p>
        <a href="/sources">Datenquellen öffnen</a>
      </section>
    );
  return <RunWorkspace runs={runs.data} />;
}
function RunWorkspace({ runs }: { runs: Run[] }) {
  const [params, setParams] = useSearchParams();
  const activeId =
    params.get("run_id") ||
    runs.find((r) => r.id === "demo-stress")?.id ||
    runs[0].id;
  const run = runs.find((r) => r.id === activeId);
  const catalog = useResource<Metric[]>(
    run ? `/analysis/runs/${encodeURIComponent(run.id)}/metrics` : null,
  );
  if (!run)
    return (
      <ErrorState
        message="Der Run aus diesem Link ist nicht vorhanden."
        retry={() => setParams({})}
      />
    );
  function update(changes: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace: true });
  }
  const requestedMetric = params.get("metric_id");
  const metric =
    catalog.data?.find((m) => m.id === requestedMetric) ||
    catalog.data?.find((m) => m.id === "loading") ||
    catalog.data?.[0];
  return (
    <>
      <header className="page-heading">
        <div>
          <div className="eyebrow">NETZDATEN / SIMULATIONSERGEBNISSE</div>
          <h1>Analyseübersicht</h1>
          <p>
            Lastverläufe verstehen. Abweichungen erkennen. Elemente gezielt
            untersuchen.
          </p>
        </div>
        <span className="badge project-badge">{run.project}</span>
      </header>
      <section className="run-bar panel">
        <label>
          Simulation Run
          <select
            value={run.id}
            onChange={(e) =>
              update({
                run_id: e.target.value,
                compare_run_id: "",
                element_ids: "",
                start: "",
                end: "",
                metric_id: "",
              })
            }
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <div className="run-info">
          <span>STUDY CASE</span>
          <strong>{run.study_case}</strong>
        </div>
        <div className="run-info">
          <span>ERGEBNISSTATUS</span>
          <strong
            className={
              run.status === "completed" ? "success-text" : "warning-text"
            }
          >
            {run.status === "completed"
              ? "Abgeschlossen"
              : run.status === "partial"
                ? "Unvollständig"
                : "Fehlgeschlagen"}
          </strong>
        </div>
        <div className="run-info">
          <span>DATENQUELLE</span>
          <strong>
            {run.source === "demo" ? "Beispieldaten" : run.source}
          </strong>
        </div>
      </section>
      {catalog.loading ? (
        <Loading />
      ) : catalog.error ? (
        <ErrorState message={catalog.error} retry={catalog.reload} />
      ) : (
        metric && (
          <AnalysisWorkspace
            key={run.id}
            run={run}
            runs={runs}
            metrics={catalog.data || []}
            metric={metric}
            params={params}
            update={update}
          />
        )
      )}
    </>
  );
}
function AnalysisWorkspace({
  run,
  runs,
  metrics,
  metric,
  params,
  update,
}: {
  run: Run;
  runs: Run[];
  metrics: Metric[];
  metric: Metric;
  params: URLSearchParams;
  update: (v: Record<string, string>) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState(false);
  const query = filterQuery({
    run_id: run.id,
    metric_id: metric.id,
    compare_run_id: params.get("compare_run_id") || "",
    element_type: params.get("element_type") || "",
    search: params.get("search") || "",
    element_ids: params.get("element_ids") || "",
    start: params.get("start") || "",
    end: params.get("end") || "",
  });
  const analysis = useResource<Analysis>(`/analysis/query?${query}`);
  const data = analysis.data;
  const selected = data?.elements.find((e) => e.id === selectedId);
  const compareOptions = runs.filter(
    (r) => r.id !== run.id && r.project === run.project,
  );
  async function exportData() {
    setExporting(true);
    setExportError("");
    try {
      await downloadCsv(query);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "Export fehlgeschlagen.");
    } finally {
      setExporting(false);
    }
  }
  function select(e: ElementResult) {
    setSelectedId(e.id);
    window.dispatchEvent(
      new CustomEvent("analysis:element-selected", {
        detail: selectionPayload(run, e),
      }),
    );
  }
  const activeFilters = [
    "search",
    "element_type",
    "element_ids",
    "start",
    "end",
    "compare_run_id",
  ].some((k) => params.has(k));
  return (
    <>
      <section className="filters panel" aria-label="Analysefilter">
        <div className="filter-title">
          <SlidersHorizontal size={16} />
          <strong>Analysefilter</strong>
          <span>Alle Auswertungen folgen dieser Auswahl.</span>
        </div>
        <div className="filter-grid">
          <label>
            Messgröße
            <select
              value={metric.id}
              onChange={(e) => update({ metric_id: e.target.value })}
            >
              {metrics.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.unit})
                </option>
              ))}
            </select>
          </label>
          <label>
            Vergleichs-Run
            <select
              value={params.get("compare_run_id") || ""}
              onChange={(e) => update({ compare_run_id: e.target.value })}
            >
              <option value="">Kein Vergleich</option>
              {compareOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Von (UTC)
            <input
              type="datetime-local"
              value={(params.get("start") || run.start || "").slice(0, 16)}
              onChange={(e) =>
                update({ start: e.target.value ? `${e.target.value}:00Z` : "" })
              }
            />
          </label>
          <label>
            Bis (UTC)
            <input
              type="datetime-local"
              value={(params.get("end") || run.end || "").slice(0, 16)}
              onChange={(e) =>
                update({ end: e.target.value ? `${e.target.value}:00Z` : "" })
              }
            />
          </label>
          <label>
            Elementtyp
            <select
              value={params.get("element_type") || ""}
              onChange={(e) =>
                update({ element_type: e.target.value, element_ids: "" })
              }
            >
              <option value="">Alle Typen</option>
              <option value="line">Leitungen</option>
              <option value="transformer">Transformatoren</option>
              <option value="terminal">Sammelschienen</option>
              <option value="load">Lasten</option>
              <option value="generator">Generatoren</option>
            </select>
          </label>
          <label className="search-field">
            Element suchen
            <div>
              <Search size={15} />
              <input
                placeholder="Name oder stabile ID …"
                value={params.get("search") || ""}
                onChange={(e) => update({ search: e.target.value })}
              />
            </div>
          </label>
        </div>
        <div className="filter-footer">
          <span>
            {params.get("element_ids")
              ? `Einzelauswahl: ${params.get("element_ids")}`
              : "Alle passenden Elemente"}{" "}
            ·{" "}
            {metric.lower != null || metric.upper != null
              ? `Grenzen: ${metric.lower ?? "−∞"} bis ${metric.upper ?? "+∞"} ${metric.unit}`
              : "Keine Grenzwerte für diese Messgröße"}
          </span>
          <button
            disabled={!activeFilters}
            onClick={() =>
              update({
                search: "",
                element_type: "",
                element_ids: "",
                start: "",
                end: "",
                compare_run_id: "",
              })
            }
          >
            <FilterX size={14} />
            Filter zurücksetzen
          </button>
        </div>
      </section>
      {analysis.loading ? (
        <Loading />
      ) : analysis.error ? (
        <ErrorState message={analysis.error} retry={analysis.reload} />
      ) : (
        data && (
          <>
            <div className="result-toolbar">
              <span>
                <i className="status-dot" />
                {data.meta.element_count} Elemente ·{" "}
                {data.meta.sample_count.toLocaleString("de-DE")} Messpunkte
                {data.stats.missing > 0 &&
                  ` · ${data.stats.missing} fehlend / ungültig`}
              </span>
              <button
                onClick={() => void exportData()}
                disabled={exporting || !data.meta.sample_count}
              >
                <Download size={15} />
                {exporting ? "Export läuft …" : "CSV exportieren"}
              </button>
            </div>
            {exportError && (
              <p className="error" role="alert">
                {exportError}
              </p>
            )}
            <KpiStrip data={data} />
            {data.comparison && (
              <p className="comparison-note">
                Vergleich mit {data.comparison.run.name}:{" "}
                {data.comparison.matched_count.toLocaleString("de-DE")}{" "}
                Wertepaare mit identischer Element-ID und UTC-Zeit. Δ =
                aktueller Run minus Vergleich.
              </p>
            )}
            {!data.stats.count ? (
              <section className="panel state">
                <h2>Keine gültigen Messwerte in dieser Auswahl</h2>
                <p>
                  Zeitraum, Elementtyp oder Messgröße ändern. Spannung ist im
                  Beispieldatensatz an Sammelschienen verfügbar.
                </p>
              </section>
            ) : (
              <Suspense
                fallback={<Loading label="Diagramme werden geladen …" />}
              >
                <AnalysisCharts data={data} />
              </Suspense>
            )}
            <ElementTable
              key={query}
              elements={data.elements}
              unit={data.metric.unit}
              onSelect={select}
              selectedId={selectedId || undefined}
            />
            {selected && (
              <ElementDetail
                key={selected.id}
                run={run}
                element={selected}
                onClose={() => setSelectedId(null)}
                onFilter={(id) =>
                  update({ element_ids: id, search: "", element_type: "" })
                }
              />
            )}
          </>
        )
      )}
    </>
  );
}
