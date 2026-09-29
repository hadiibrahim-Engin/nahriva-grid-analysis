import { CheckCircle2, Database, PlugZap } from "lucide-react";
import type { Capabilities } from "../api/types";

export default function SourcesPage({
  capabilities,
}: {
  capabilities: Capabilities;
}) {
  return (
    <>
      <header className="page-heading">
        <div>
          <div className="eyebrow">DATEN / HERKUNFT & ANBINDUNG</div>
          <h1>Datenquellen</h1>
          <p>
            Transparente Herkunft, eindeutige Einheiten und stabile
            Elementreferenzen.
          </p>
        </div>
      </header>
      <div className="sources-grid">
        <section className="panel source-card">
          <CheckCircle2 size={24} />
          <h2>Simulationsergebnisse</h2>
          <span className="badge">
            {capabilities.mode === "demo"
              ? "Beispieldaten aktiv"
              : "SQL-Ergebnisspeicher aktiv"}
          </span>
          <p>
            {capabilities.mode === "demo"
              ? "Zwei reproduzierbare Beispiel-Runs mit 15-Minuten-Werten. Diese Daten stammen aus keiner realen PowerFactory-Berechnung."
              : "Importierte Simulation Runs aus einer eigenständigen SQLite-Datenbank. Keine automatischen Beispieldaten."}
          </p>
          <p>
            Gemeinsame Filter steuern Kennzahlen, Diagramme, Elementtabelle und
            Export. Ungültige Werte bleiben als fehlend sichtbar.
          </p>
        </section>
        <section className="panel source-card">
          <Database size={24} />
          <h2>Oracle / FDWH</h2>
          <span className="badge">
            {capabilities.oracle_configured
              ? "Konfiguriert · Anmeldung erforderlich"
              : "Noch nicht konfiguriert"}
          </span>
          <p>
            Bestehende Anlagen-, Betriebsmittel- und Messwertabfragen bleiben
            verfügbar. Die Anmeldung verwendet das vorhandene Oracle-Konto.
          </p>
          <p>
            Die optionale DuckDB-Lesereplik und ihre Sync-Scripts sind erhalten.
            FDWH und Simulationsergebnisse bleiben getrennte Datenquellen.
          </p>
        </section>
        <section className="panel source-card">
          <PlugZap size={24} />
          <h2>PowerFactory</h2>
          <span className="badge">Bridge noch nicht verbunden</span>
          <p>
            Elemente tragen eine stabile ID, Klasse, einen Typ und optional
            ihren vollständigen Objektpfad. Die Auswahl kann bereits als
            strukturierte Referenz kopiert werden.
          </p>
          <p>
            Eine spätere Bridge kann damit den passenden Study Case und das
            Element in der Netzgrafik adressieren.
          </p>
        </section>
      </div>
      <section className="panel documentation">
        <h2>Eigene Simulationsergebnisse einlesen</h2>
        <ol>
          <li>
            Ergebnisse im versionierten JSON-Format exportieren. Vertrag:{" "}
            <code>docs/run-bundle.schema.json</code>; Beispiel:{" "}
            <code>docs/example-run.json</code>.
          </li>
          <li>
            Im Backend importieren:{" "}
            <code>
              python scripts/import_results.py results.json --database
              data/analysis.sqlite3
            </code>
            .
          </li>
          <li>
            <code>ANALYSIS_MODE=sqlite</code> und bei Bedarf{" "}
            <code>ANALYSIS_DB_PATH</code> konfigurieren. Oracle-Anmeldung
            einrichten und Backend neu starten.
          </li>
        </ol>
        <p>
          Importe sind atomar und ergänzend. Doppelte Run-IDs werden abgelehnt.
          Vorhandene Oracle-Tabellen werden nicht verändert.
        </p>
      </section>
      <section className="panel documentation">
        <h2>Mess- und Vergleichsregeln</h2>
        <p>
          Simulationstimestamps benötigen eine Zeitzone und werden nach UTC
          normalisiert. Einheiten und optionale Grenzen gehören zur Messgröße
          eines Runs. Nur Werte außerhalb der Grenzen zählen als Verletzung.
        </p>
        <p>
          Run-Vergleiche verwenden dieselbe Messgröße und Einheit im selben
          Projekt. Das Delta entsteht ausschließlich aus Paaren mit identischer
          Element-ID und identischem Zeitstempel. Leistungen verschiedener
          Netzelemente werden nicht zu einer vermeintlichen Netzlast
          aufsummiert.
        </p>
      </section>
    </>
  );
}
