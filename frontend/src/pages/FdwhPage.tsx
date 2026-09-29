import { lazy, Suspense, useState, type FormEvent } from "react";
import { Database } from "lucide-react";
import { useResource } from "../hooks/useResource";
import { ErrorState, Loading } from "../components/States";
import Login from "../components/Login";
import type { Capabilities } from "../api/types";
import { formatChartNumber as fmt } from "../components/charts/format";
const SeriesChart = lazy(() =>
  import("../components/charts/AnalysisCharts").then((m) => ({
    default: m.SeriesChart,
  })),
);
interface Facility {
  id: string;
  name: string;
}
interface Timeseries {
  data: { timestamp: string; value: number | null }[];
  unit: string;
  next_cursor?: string | null;
  meta: { is_raw: boolean; point_count: number };
}

export default function FdwhPage({
  authenticated,
  capabilities,
  onLogin,
}: {
  authenticated: boolean;
  capabilities: Capabilities;
  onLogin: () => void;
}) {
  return (
    <>
      <header className="page-heading">
        <div>
          <div className="eyebrow">MESSDATEN / ORACLE FDWH</div>
          <h1>Messdaten untersuchen</h1>
          <p>
            Vorhandene Datenbankabfragen und Analyse-Services direkt
            weiterverwenden.
          </p>
        </div>
        <Database size={26} />
      </header>
      {!capabilities.oracle_configured ? (
        <section className="panel state">
          <h2>Oracle ist noch nicht konfiguriert</h2>
          <p>
            Der bestehende FDWH-Adapter ist erhalten. Hinterlege die Verbindung
            im Backend, um Anlagen und Messdaten zu laden.
          </p>
          <a href="/sources">Konfiguration und Datenquellen</a>
        </section>
      ) : !authenticated ? (
        <Login onSuccess={onLogin} />
      ) : (
        <Explorer />
      )}
    </>
  );
}
function Explorer() {
  const facilities = useResource<Facility[]>("/facilities");
  const [facility, setFacility] = useState("");
  const [component, setComponent] = useState("");
  const components = useResource<Facility[]>(
    facility ? `/facilities/${encodeURIComponent(facility)}/components` : null,
  );
  const [path, setPath] = useState<string | null>(null);
  const [cursor, setCursor] = useState("");
  const series = useResource<Timeseries>(
    path
      ? path + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "")
      : null,
  );
  const [queryLabel, setQueryLabel] = useState("");
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const mode = String(form.get("mode"));
    const params = new URLSearchParams({
      start: String(form.get("start")) + ":00",
      end: String(form.get("end")) + ":00",
    });
    if (mode === "aggregate") {
      params.set("bucket", "3600");
      params.set("aggregation_method", "AVG");
    } else params.set("limit", "5000");
    setCursor("");
    setQueryLabel(
      mode === "aggregate"
        ? "Explizite Aggregation · 1 Stunde · AVG"
        : "Native Rohdaten · aktuelle Seite · höchstens 5.000 Werte",
    );
    setPath(
      `/timeseries/${mode}/${encodeURIComponent(component)}/${String(form.get("metric"))}?${params}`,
    );
  }
  if (facilities.loading) return <Loading />;
  if (facilities.error)
    return <ErrorState message={facilities.error} retry={facilities.reload} />;
  return (
    <>
      <form className="panel filters" onSubmit={submit}>
        <div className="filter-grid">
          <label>
            Anlage
            <select
              value={facility}
              required
              onChange={(e) => {
                setFacility(e.target.value);
                setComponent("");
                setPath(null);
              }}
            >
              <option value="">Anlage auswählen</option>
              {facilities.data?.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Betriebsmittel
            <select
              value={component}
              required
              disabled={!components.data}
              onChange={(e) => {
                setComponent(e.target.value);
                setPath(null);
              }}
            >
              <option value="">Element auswählen</option>
              {components.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Messgröße
            <select name="metric">
              <option value="P">Wirkleistung P (MW)</option>
              <option value="Q">Blindleistung Q (Mvar)</option>
              <option value="U">Spannung U (kV)</option>
              <option value="I">Strom I (A)</option>
              <option value="S">Scheinleistung S (MVA)</option>
            </select>
          </label>
          <label>
            Auflösung
            <select name="mode">
              <option value="raw">Native Rohdaten</option>
              <option value="aggregate">1 Stunde · Mittelwert</option>
            </select>
          </label>
          <label>
            Von (FDWH-Lokalzeit)
            <input type="datetime-local" name="start" required />
          </label>
          <label>
            Bis (FDWH-Lokalzeit)
            <input type="datetime-local" name="end" required />
          </label>
        </div>
        <button className="primary" disabled={!component || series.loading}>
          Messdaten laden
        </button>
      </form>
      {components.error && (
        <ErrorState message={components.error} retry={components.reload} />
      )}
      {components.loading && (
        <Loading label="Betriebsmittel werden geladen …" />
      )}
      {series.loading ? (
        <Loading />
      ) : series.error ? (
        <ErrorState message={series.error} retry={series.reload} />
      ) : (
        series.data && (
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>{queryLabel}</h2>
                <p>
                  {series.data.data.length.toLocaleString("de-DE")} geladene
                  Werte · Originale FDWH-Lokalzeit, ohne Zeitzonenumrechnung
                </p>
              </div>
            </div>
            <Suspense fallback={<Loading />}>
              <SeriesChart
                unit={series.data.unit}
                points={series.data.data.map((p) => ({
                  timestamp: /Z$|[+-]\d\d:\d\d$/.test(p.timestamp)
                    ? p.timestamp
                    : `${p.timestamp}Z`,
                  mean: p.value,
                }))}
              />
            </Suspense>
            {series.data.next_cursor && (
              <button onClick={() => setCursor(series.data?.next_cursor || "")}>
                Nächste Rohdatenseite
              </button>
            )}
            <details>
              <summary>Erste 50 Werte der aktuellen Seite anzeigen</summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Zeitstempel</th>
                      <th>Wert ({series.data.unit})</th>
                    </tr>
                  </thead>
                  <tbody>
                    {series.data.data.slice(0, 50).map((p) => (
                      <tr key={p.timestamp}>
                        <td>{p.timestamp}</td>
                        <td>{fmt(p.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </section>
        )
      )}
    </>
  );
}
