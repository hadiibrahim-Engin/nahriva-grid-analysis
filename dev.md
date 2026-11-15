# Master-Prompt: Outage Assessment → PowerFactory-Analyseplattform

## 0. Auftrag und Arbeitsweise

Erweitere das **bestehende** Outage-Assessment-Dashboard in diesem Repository schrittweise zu einer
performanten Analyseplattform für Berechnungsergebnisse aus DIgSILENT PowerFactory (und später externen,
CGMES-basierten Tools). **Kein Neubau:** Backend, Datenbank-Layout, Import-Bridge, Frontend und Tests in diesem
Repository sind die Basis. Ersetze eine vorhandene Komponente nur, wenn ein Benchmark oder eine Anforderung
dies belegt, und dokumentiere die Begründung.

Arbeite in den Phasen aus Abschnitt 8. **Am Ende jeder Phase anhalten**, Ergebnis und Messwerte berichten und
auf Freigabe warten. Triff keine unbegründeten Annahmen über PowerFactory-Module oder externe Tools; markiere
Annahmen und offene Entscheidungen ausdrücklich.

Priorität in dieser Reihenfolge: **fachliche Korrektheit und Datenintegrität → Reaktionszeit → Bedienbarkeit →
Funktionsumfang.**

---

## 1. Ausgangslage – was bereits existiert

Lies vor jeder Planung diese Dateien: `README.md`, `docs/GRIDLENS.md`, `docs/DATABASE.md`,
`docs/ASSESSMENT.md`, `docs/DEPLOYMENT.md`, `powerfactory/SOURCE.md`.

### 1.1 PowerFactory-Weg (Weg A, vorhanden)

- Einstieg: `powerfactory/start_assessment.py` (ComPython in PowerFactory 2026, nur Standardbibliothek).
- Ablauf: Vorabprüfung (Ordner schreibbar, ≥ 2 GB frei, DB-Schema) → Dashboard-Server startet im Hintergrund →
  **Case Manager** von GridLensAssessment `main.py` 8.1 (tkinter) → REF- und Fall-QDS, n-1 und (n-1)' nativ in
  PowerFactory → Wiederherstellung aller geänderten Einstellungen (verifiziert) → Import.
- `powerfactory/gridlens_runtime.py` ist eine Kopie von main.py mit **einem** Hook (`result_consumer`) nach der
  Wiederherstellung, statt Report-Auswertung und PDF. Pflege laut `powerfactory/SOURCE.md`.
- `powerfactory/gridlens_dashboard.py` (Bridge): liest die kept `ElmRes` spaltenweise (`GetColumnValues`),
  committet **pro Fall**, schreibt dabei die Dashboard-Zusammenfassung (`pf_scenario_cells`) und die
  n-1-Verdichtung (`gl_n1_hourly`, `gl_n1_columns`). Der Browser öffnet sich nach dem ersten gespeicherten Fall.
- Der **PDF-Reporting-Weg** (main.py mit IntReport) bleibt eigenständig und wird nicht mit dem Dashboard vermischt.

### 1.2 Datenhaltung (vorhanden)

- Eine SQLite-Datei je Arbeitsplatz, WAL (Lesen blockiert nie den Schreiber). Schema und Begründungen:
  `docs/DATABASE.md`, `backend/app/analysis/migrations/002_analysis.sql`, `backend/app/simulation/store.py`,
  `backend/app/simulation/gridlens_store.py`.
- Zeitreihen kompakt: `analysis_series` + `analysis_values` (WITHOUT ROWID, Epoch-Sekunden UTC, `NULL` = kein Wert).
- Native Rohdaten-Vertrag `gl_*`: Assessments, Fälle, Ergebnisobjekte, Spalten, Ausfälle (Contingencies),
  Zeitpunkte, dünn besetzte n-1-Zellen mit Zustand (`value`, `not_recorded` = PF-Code 3 innerhalb der
  Aufzeichnungsgrenzen, `missing_row`, `missing_column`, `invalid`, `read_error`).
- Asset-Kennung heute: SHA-256 aus `<Projektpfad>|<PowerFactory-Objektpfad>`; Grid aus dem `ElmNet` im Pfad.

### 1.3 Dashboard (vorhanden)

- Stack: FastAPI (Python ≥ 3.12) + React 19 / TypeScript / Vite / ECharts 6, ausgeliefert vom selben Server,
  ein Port (Standard 8765, `127.0.0.1`). Kein Login; die API schreibt keine Ergebnisse (einzige
  Ausnahme: lokaler Wechsel der Datenbankdatei, gesperrt sobald der Server im Netz erreichbar ist).
- Zusammenfassung: Key figures (KPIs), Bewertung je Szenario, Lastprofil, Szenariodetails, Spannungsmatrix,
  Betriebsmittel×Szenario-Matrix, Vergleichs-Charts, Radar, Detailtabelle (virtualisiert), **n-1-Auswertung (Vorher → Nachher, Sankey)**
  (je Leitung: Auslastung vor/nach n-1 und auslösender Ausfall).
- „Added charts“: 20 Vorlagen in 5 Kategorien (Zeitreihen, Verteilung inkl. Boxplot/Dauerlinie,
  Grenzwerte, Korrelation inkl. 3D, Szenariobewertung), PNG-Export.
- Filter: Grid, Szenario, Betriebsmittel, Messgröße, Betriebsmittelart. Ansicht wird lokal gespeichert
  (`frontend/src/util/savedView.ts`). Hell/Dunkel. Fortschrittsbanner während der Rechnung.
- Grenzwerte/Bänder zentral in `frontend/src/config/`; die Bridge zählt n-1-Verletzungen mit den
  Grenzwerten der Lauf-Einstellungen.

### 1.4 Gemessene Leistung (synthetisch, MacBook, Stand 2026-11)

| Messung | Wert |
|---|---|
| Import 660 Serien × 8.760 h × 7 Läufe (≈ 28 Mio. Werte) + 12 n-1-Sweeps (≈ 95 Mio. Zellen) | ≈ 60 s |
| Erster Fall sichtbar nach Ende der PowerFactory-Rechnung | ≈ 7,5 s |
| Bewertung aller Szenarien (vorbereitete Zusammenfassung) | ≈ 11 ms |
| n-1-Zusammenfassung auf 13,4 Mio. n-1-Zellen (früherer Gantt) | ≈ 21 ms (5 ms gecacht) |
| Anteil SQLite-Insert am Import | ≈ 70 % (≈ 0,48 µs je Wert) |

### 1.5 Testdaten und Tests (vorhanden)

- `backend/tests/qds_fixture.py` (kleine Fixture), `backend/tests/large_dataset.py` (großer synthetischer Lauf
  über den echten Pfad: Runtime → Wiederherstellung → Bridge). Beide nur Entwicklung, nicht im Release.
- `bash scripts/check.sh`: Ruff, pytest, Frontend-Typecheck/Lint/Tests/Build.

---

## 2. Rahmenbedingungen (verbindlich, solange in Abschnitt 4 nicht anders entschieden)

- Läuft auf dem PowerFactory-PC als normaler Benutzer: **keine Adminrechte, kein Dienst, keine Firewallregel,
  ein Port**, Standard `127.0.0.1`. Netzwerkfreigabe nur auf ausdrücklichen Wunsch des Betreibers.
- Keine CDN- oder Internetabhängigkeit zur Laufzeit.
- PowerFactory-seitiger Code: nur Standardbibliothek und `powerfactory`-Modul, **mit einer Ausnahme (E2, 2026-11-15):
  pyarrow** zum Schreiben der Rohwerte als Parquet. Es kommt aus `backend\.venv`, wenn PowerFactorys Python dieselbe
  Version hat (Annahme A10), sonst bricht der Lauf vor dem Rechnen mit einer klaren Meldung ab.
- **Code, Oberfläche, Kommentare, Doku und Tests auf Englisch.** Dieser Prompt ist deutsch.
- Keine Demo-Modi in Produktion; synthetische Daten nur unter `backend/tests/`.
- Das Dashboard rechnet **keine** Netzberechnungen und übernimmt **keine** main.py-Report-Bewertung; es
  analysiert gespeicherte Rohergebnisse.
- **Fehlende Ergebnisse sind nie 0.** Jeder Zustand wird ausdrücklich gespeichert und angezeigt.
- Nicht mehr Benötigtes wird entfernt, nicht auskommentiert.

---

## 3. Zielbild

### 3.1 Drei Berechnungswege, ein Dashboard

- **Weg A – PowerFactory** (vorhanden, siehe 1.1).
- **Weg B – Externe Berechnung über CGMES:** PowerFactory-Modell → CGMES-Export → externes Tool →
  Ergebnisadapter normalisiert Asset-Kennungen, Variablen, Einheiten, Zeitachsen → gleiches Datenmodell.
- **Weg C – TOOLX-Schaltzustand:** CGMES-Import in ein PowerFactory-Zielmodell → Validierung → Rechnung wie Weg A.

Für B und C zunächst **nur Schnittstellenverträge**, keine Implementierung, bis die Spezifikation der externen
Tools vorliegt (offene Entscheidung E6).

### 3.2 Analyseperspektiven

- **Zeitpunkt:** Netzzustand zu einem gewählten Zeitpunkt (Auslastungs-/Spannungsverteilung, Verletzungen,
  Sprung zu kritischen Zeitpunkten).
- **Vergleich:** Analyse A gegen B, Referenz gegen Szenario; absolute/relative Deltas je Asset, Zeitpunkt,
  Variable; Ranking; Vergleichbarkeitsprüfung bei abweichendem Modellstand, Zeitachse oder Assetbestand.
- **Asset:** Suche, Stammdaten, Grid/Spannungsebene, Zeitreihen, Min/Max/Mittel, kritische Zeitpunkte,
  betroffene Szenarien und Ausfälle, Abweichung zur Referenz, Vergleich über Analysen.

### 3.3 Analysearten

Vorhanden: QDS, n-1 und (n-1)' über die Zeitschritte der Ausfallfenster. Das Datenmodell muss erweiterbar sein
für Lastfluss (Betriebspunkte), Kurzschluss (Fehlerort, -art, Methode) und Netzplanung, **ohne** alles in die
QDS-Struktur zu pressen.

---

## 4. Offene Entscheidungen (vor der jeweiligen Phase klären)

| # | Frage | Vorschlag bis zur Entscheidung |
|---|---|---|
| E1 | Mehrbenutzerbetrieb mit zentralem Katalog (PostgreSQL), Netzlaufwerk und Rechten – ja/nein, ab wann? | Nein. Local-first bleibt; Phase 5 entwirft nur Konzept und Verträge. |
| E2 | Datenformat: DuckDB/Parquet zusätzlich oder statt SQLite? | **Entschieden (Betreiber, 2026-11-07) und umgesetzt (2026-11-15):** Die Bridge schreibt die QDS-Rohwerte je Lauf direkt als Parquet (`<db>.values/<run>.parquet`, ZSTD, Blöcke 1.000 Reihen × 1 Woche, unveränderlich, SHA-256 in `pf_run_values`); das Dashboard liest sie mit DuckDB; SQLite behält Metadaten, Stammdaten und Verdichtungen (`docs/STORAGE.md`). Ältere Läufe und alte Wiederherstellungen bleiben in SQLite lesbar; neue Archiv-Wiederherstellungen behalten Parquet. Layout 15 ergänzt den vollständigen Lesezugang und die Speicherort-View; Messung: `docs/PERFORMANCE.md`. **Offen:** n-1-Zellen (`gl_values`) liegen noch in SQLite. |
| E3 | Netzkarte: gewünscht? Woher kommen Topologie/Koordinaten (CGMES-DL, PowerFactory-Grafik)? | **Entschieden (Betreiber, 2026-11-07): Figma-Weg.** Schematische Karte als SVG-Export der Figma-Netzkarte des Betreibers; Betriebsmittel als Ebenen in der Gruppe „Elements“, Ebenenname = PowerFactory-Name (bei Doppelungen mit Netzgebiet oder Pfad); kein Figma-Zugriff zur Laufzeit. **Umgesetzt** (`docs/MAP.md`, Beispiel IEEE 39-Bus über `scripts/try_example.sh`). Geo-Trassen als JSON optional später über dieselbe Zuordnung. |
| E4 | LODF: weiter anzeigen (dann Berechnungsquelle nötig) oder entfernen? | Offen; aktuell ohne Datenquelle, zeigt „not calculated“. |
| E5 | Anmeldung und Rechte (z. B. Windows-Anmeldung) | Nur mit E1. |
| E6 | Spezifikation externes CGMES-Tool und TOOLX (Formate, Variablen, Methoden) | Nur Verträge, keine Annahmen. |

**Annahmen (Stand Phase 1, zu bestätigen):**

- A1 PowerFactory 2026 verhält sich wie die Stand-ins der Tests (`GetColumnValues`, Code 3, `cnttime` in
  Epoch-Sekunden, verifizierte Wiederherstellung). Ein Lauf auf dem echten Windows-PC steht aus.
- A2 Zeiten von `IntPlannedout` und `ComStatsim` sind Epoch-Sekunden; die Sommerzeit-Behandlung der Fenstergrenzen
  ist nicht verifiziert.
- A3 Je Datenbankdatei schreibt genau ein Prozess (die Bridge); das Dashboard liest nur (WAL).
- A4 Die Asset-Identität aus Projekt- und Objektpfad ist innerhalb eines Projekts stabil; Umbenennen oder
  Verschieben trennt die Historie eines Assets.
- A5 Die Werte für 100.000 Assets sind Hochrechnungen aus 660 Assets, nicht gemessen.
- A6 Die synthetischen Daten taugen für Laufzeit- und Mengentests, nicht für fachliche Plausibilität.
- A7 Aus welchem PowerFactory-Attribut die CGMES-mRID eines Objekts gelesen werden kann, ist nicht verifiziert;
  `gl_elements.mrid` bleibt bis dahin leer.
- A9 Vorzeichen der Wirkleistung wie in PowerFactory: Lasten positiv bei Verbrauch, Erzeuger und ElmXnet positiv
  bei Einspeisung, Zweige positiv vom ersten Anschluss (bus1/bushv) in den Zweig. Am echten Lauf zu prüfen
  (`docs/AREAS.md`).
- A10 PowerFactorys Python hat dieselbe Version (major.minor, 64 Bit) wie `backend\.venv`, damit das kompilierte
  pyarrow lädt; sonst muss pyarrow in PowerFactorys Python installiert werden. Am PowerFactory-PC zu prüfen.
- A8 main.py legt den Lauf auf das Ausfallfenster (erster Beginn bis ein Schritt nach dem letzten Ende, Raster ab
  lokaler Mitternacht). Getestet über die Sommerzeit-Umstellung: Zeitachse eindeutig und gleichmäßig.

---

## 5. Mengengerüst und Performanceziele

Ziel-Mengengerüst (bitte bestätigen oder korrigieren): bis 100.000 Assets je Modell, QDS bis 1 Jahr stündlich
(8.760 Schritte) oder 15-minütlich (35.040), 3–6 Variablen je Asset, n-1 mit bis 2.000 Studienzeitpunkten und
bis 1.000 Ausfällen, hunderte gespeicherte Läufe.

Das sind bis **≈ 2,6 Mrd. Werte je QDS-Lauf** (100.000 × 8.760 × 3). Daraus folgt: kein Request darf
Rohdaten vollständig scannen. Verdichtungen werden beim Import geschrieben (Muster: `pf_scenario_cells`,
`gl_n1_*`), Abfragen lesen per Schlüssel.

Ziele (P95, warmer Cache, ein Nutzer; Mehrnutzer nur bei E1):

| Abfrage | Ziel |
|---|---|
| Analyse-/Szenarioliste, KPIs, Bewertung | < 200 ms |
| Eine Asset-Zeitreihe (1 Jahr, auf Bildschirmbreite reduziert) | < 300 ms |
| Netzzustand zu einem Zeitpunkt (alle Assets eines Grids) | < 1 s |
| Top-N-Verletzungen, n-1-Auswertung | < 500 ms |
| Erster Fall sichtbar nach PowerFactory-Ende | < 10 s |

Messe P50/P95, CPU, RAM, Datei-I/O, kalter und warmer Cache. Benchmarks mit
`backend/tests/large_dataset.py` (Größe per Parameter) und einem zusätzlichen 100.000-Asset-Datensatz.

---

## 6. Datenmodell – Erweiterung des Bestehenden

- **Gemeinsame Laufmetadaten** (in `gl_assessments`/`gl_results` ergänzen): `run_id`, `analysis_id`,
  `scenario_id`, `reference_analysis_id`, `calculation_type`, `source_system`, Projekt, Modell und
  Modellversion, Study Case, Zeitstempel, Status, `result_schema_version`.
- **Ausfall-Dimension überall, wo sie fachlich existiert:** QDS-Werte (`run`, `asset`, `variable`, `t`),
  n-1-Werte (`run`, `contingency`, `asset`, `variable`, `t`), Kurzschluss (`run`, `fault`, `asset`, `variable`).
- **Zustände** (einheitlich, versioniert): vorhanden; nicht aufgezeichnet (innerhalb Aufzeichnungsgrenzen,
  PF-Code 3); nicht angefordert; nicht berechnet; fehlgeschlagen; Asset außer Betrieb; noch nicht in Betrieb;
  unvollständig; ungültig; Zeile fehlt (Ausfall nicht anwendbar); Spalte fehlt.
- **Asset-Identität:** CGMES-mRID, wo vorhanden; sonst der heutige Schlüssel (SHA-256 aus Projekt- und
  Objektpfad). Versioniertes Mapping PowerFactory-Objekt ↔ CGMES-Objekt ↔ Ergebnis-Asset.
- **Zeit:** gespeichert in Epoch-Sekunden UTC. PowerFactory liefert Epoch-Sekunden (ComStatsim, IntPlannedout),
  main.py bildet Tagesgrenzen aber in Ortszeit; Zeitzone und Sommerzeit der Anzeige und der Fenstergrenzen
  prüfen, festlegen und testen. Keine Interpolation, keine erfundenen Zeitpunkte.
- **Grenzwerte:** Quelle je Wert festhalten (Lauf-Einstellung, Betriebsmittel-Bemessung, Dashboard-Konfiguration);
  nicht im Code verankern.
- **Downsampling** für Diagramme erhält Spitzen und Lücken (Min/Max je Intervall), nie Mittelwerte allein.
- Schemaänderungen über `LAYOUT_VERSION`/Migrationen; bestehende Dateien werden beim Öffnen ergänzt oder klar
  abgelehnt.

---

## 7. Dashboard – Abgleich Zielbild gegen Ist-Stand

Geprüft in Phase 1 (2026-11-07) gegen den Code; Diagramme, Messwerte und Belege: `docs/ARCHITECTURE.md`.

| Anforderung | Stand | Umsetzung |
|---|---|---|
| **Analysen sauber getrennt** (Voraussetzung für alles Weitere) | **behoben (Phase 2):** jede Analyse für sich, Standard die neueste, Feld „Analysis“ im Kopf; jedes Szenario mit dem Katalog seines Imports | – |
| Analyseverwaltung: suchen, filtern (Modell, Version, Projekt, Datum, Anwender), Status, Quelle PF/extern, Mehrfachauswahl | **vorhanden (Phase 3b):** Dialog „Compare“: Suche (Projekt, Studienfall, Lauf, Version, Datum), Statusfilter, Auswahl von zwei Analysen | Filter nach Anwender (erst wenn `created_by` befüllt ist) |
| KPI-Übersicht reagiert auf Filter | vorhanden (Key figures) | um Spannungsebene/Zeitraum-Filter erweitern |
| Szenario vs. Referenz, Deltas, Ranking | vorhanden (Matrix, Comparison, Radar, Detailtabelle); **Phase 3b:** Analyse A gegen B mit Vergleichbarkeitsprüfung (Projekt, Studienfall, Version, Zeitraum, Einstellungen, Elemente, Ausfallfenster), Szenariopaare nach ausgeschalteten Betriebsmitteln, je Paar alle Elemente mit A, B und B − A (seitenweise, Suche, CSV) | Vergleich eines Assets über mehrere Analysen |
| n-1-Auswertung | **umgebaut (2026-11-15):** Arbeitsbereich „n-1 review“ und „Add chart“: Vorher → Nachher je Paar „überlastete Leitung ← Ausfall“ und Sankey Ausfall → überlastete Leitungen; der Gantt ist entfernt | Zeitverlauf eines Paars per Klick, Spannung |
| Zeitpunkt-Ansicht (Netzzustand zu t) | **vorhanden (Phase 3):** Zeitverlauf je Szenario gegen REF, kritische Zeitpunkte, alle Elemente zu t (seitenweise, CSV); Verdichtung `pf_run_times` beim Import | Zeitverlauf bei 15-min-Daten reduziert ausliefern |
| Asset-Explorer | **vorhanden (Phase 3):** Stammdaten, Kennzahlen je Szenario, n-1 je Fall, Zeitreihe gegen REF, CSV | Vergleich eines Assets über mehrere Analysen |
| Globale Filter (Analyse, Referenz, Szenario, Zeitraum, Zeitpunkt, Grid, Spannungsebene, Asset-Typ, Variable, Status) | vorhanden: Analyse, Grid, **Spannungsebene (Phase 3)**, Szenario, Betriebsmittel, Messgröße, Art; Zeitpunkt in der Zeitpunkt-Ansicht; **Phase 3b:** Berechnungsstatus (alle / vollständig / mit Problemen) und Zeitraum (UTC) für Zeitverlauf und Asset-Zeitreihe, beide in der Adresse | Zeitraum auch für n-1-n-1-Diagramme und „Added charts“ |
| Bookmarks für Filter/Layouts | **vorhanden (Phase 3b):** benannte Bookmarks (Analyse gepinnt, Grid, Spannungsebene, Szenario), als Link und als Datei teilbar; die Adresszeile ist immer die aktuelle Ansicht | Abschnitt und Diagramm-Layout im Bookmark |
| Diagramme konfigurierbar, PNG-Export | **vorhanden (Phase 3):** 20 Vorlagen, PNG für jedes Diagramm, CSV für Detailtabelle, Zeitpunkt und Asset, JSON für das Restore-Paket | CSV der Diagrammdaten in „Added charts“ |
| Fehlende Werte sichtbar, Downsampling erhält Spitzen | **behoben (Phase 2):** Lücken mit Zustand, `MINMAX` als Standard, Zustandskatalog `/states` | Anzeige des Zustands im Tooltip (Phase 3) |
| Last- und Erzeugungsanalyse | **vorhanden (2026-11-08):** Widget „Areas“ je Netzgebiet: Last, Erzeugung, Saldo, Flüsse zwischen Gebieten, Transit, Tages-Heatmap, Szenario gegen REF (`docs/AREAS.md`); nur wenn die Wirkleistung in ComStatsim aufgezeichnet ist, sonst „Cannot evaluate“ mit den fehlenden Variablen | Gruppierung nach PowerFactory-Areas/-Zonen; nach Erzeugungstyp |
| Grenzwerte konfigurierbar | **vorhanden (Phase 3b):** Dialog „Limits“ (Lastbänder, Spannungsband, Abstand, Reserve, Verschärfung), je Browser; Quelle im Dialog benannt | zentral für alle Nutzer (nur mit E1) |
| Tabellen: Suche, Sortierung, Virtualisierung | **vorhanden (Phase 3b):** Virtualisierung; Betriebsmittelliste ab 2.000 Elementen mit Server-Suche; Netzzustand seitenweise; große Analysen listen relevante Elemente (bei 100.000: 65 MB → 10 MB je Szenario, Bewertungen exakt) | – |
| Netzkarte | fehlt (bewusst entfernt) | nur nach E3 |
| PowerFactory-Rückführung (Restore-Paket) | **vorhanden (Phase 3):** prüfbarer JSON-Dialog je Szenario und Zeitpunkt, Einschränkungen zuerst (`reproducible: partial`) | Gegenstück in PowerFactory (eigenes Modul) |
| DuckDB/Parquet, Netzlaufwerk, Katalog, Mehrbenutzer | **Parquet-Archiv vorhanden (Phase 4):** `scripts/export_parquet.py`, Prüfung mit `--verify`; Netzlaufwerk, Katalog, Mehrbenutzer fehlen | Netzlaufwerk/Katalog nur nach E1; Rohwerte in Parquet nur nach E2b |
| CGMES-Adapter (Weg B/C) | fehlt | nur Verträge (E6) |

---

## 8. Phasen mit Abnahmekriterien

Jede Phase endet mit: grüne Checks (`bash scripts/check.sh`), aktualisierte Doku, Messwerte, Halt.

1. **Bestandsaufnahme und Gap-Analyse (kein Code).** Architektur- und Datenflussdiagramm des Ist-Stands,
   Bestätigung oder Korrektur der Tabelle in Abschnitt 7, Liste der Annahmen. *Abnahme:* Diagramme stimmen mit
   dem Code überein; offene Entscheidungen sind beantwortet oder vertagt. **Erledigt 2026-11-07:**
   `docs/ARCHITECTURE.md`, Tabelle in Abschnitt 7 korrigiert.
2. **Datenmodell und Verträge.** **Erledigt 2026-11-07** (Tests: `backend/tests/test_analysis_contract.py`):
   Analysen getrennt, Lücken mit Zustand, Stammdaten mit Nennspannung, Analyse-Status und -Metadaten,
   Zustandskatalog, Sommerzeit-Test, Migration Layout 9 → 10. Offen daraus: Modell/Modellversion (keine
   gesicherte PowerFactory-Quelle), `reference_analysis_id` (REF liegt heute innerhalb der Analyse). Ursprünglicher
   Umfang: Laufmetadaten, Zustandskatalog, Zeitregeln, Asset-Mapping, Erweiterungspunkte
   für Lastfluss/Kurzschluss; Migration für bestehende Dateien; Bridge und Fixtures angepasst. *Abnahme:*
   Tests für jeden Zustand, Sommerzeit, fehlende mRID; alte Datenbanken werden ergänzt oder klar abgelehnt.
3. **Dashboard-Erweiterung.** Globale Filter, Analyse-Browser, Zeitpunkt-Ansicht, Asset-Explorer, Bookmarks,
   CSV/JSON-Export, konfigurierbare Grenzwerte, Restore-JSON-Dialog. *Abnahme:* Ziele aus Abschnitt 5 auf dem
   großen Datensatz eingehalten; Browser-Test der Kerninteraktionen.
   **Teilweise erledigt 2026-11-07** (Tests: `backend/tests/test_timepoint.py`; im Browser geprüft): Zeitpunkt-Ansicht,
   Asset-Explorer, Restore-Dialog, Spannungsebenen-Filter, teilbarer Link, PNG/CSV-Export, Übersicht je Analyse.
   Alle neuen Abfragen < 20 ms (200 Zweige, 1 Jahr, Akku/Stromsparmodus). **Offen (Phase 3b):** Grenzwerte in der
   Oberfläche, Analyse-Browser mit Suche und Mehrfachauswahl, benannte Bookmarks, Zeitraum-/Status-Filter,
   seitenweise Bewertung und Betriebsmittelliste für 100.000 Assets (Abschnitt 5), Zeitverlauf reduziert ausliefern.
   **Phase 3b erledigt 2026-11-07:** auf einem echten 100.000-Asset-Datensatz gemessen (`docs/ARCHITECTURE.md`): Index
   970 → 1,5 ms, Bewertung 65 → 10 MB je Szenario, Betriebsmittelsuche 133 ms, Netzzustand eines Grids 0,77 s,
   Zeitverlauf reduziert; Grenzwert-Dialog, benannte Bookmarks. **Offen:** Analyse-Browser mit Mehrfachauswahl und
   Vergleich zweier Analysen, Zeitraum- und Statusfilter, Netzzustand über alle 100.000 Elemente (1,7 s beim ersten
   Aufruf). **Offene Punkte 3b erledigt 2026-11-07** (Tests: `backend/tests/test_compare.py`, `test_timepoint.py`,
   `frontend/src/util/__tests__/timeRange.test.ts`; im Browser geprüft): Netzzustand über 100.000 Elemente
   0,42–0,46 s je Zeitpunkt (erster Zeitpunkt eines Laufs 0,98 s); Statusfilter; Zeitraumfilter (Zeitverlauf in voller
   Auflösung für den Bereich, „Use zoomed span as time range“); Analyse-Browser mit Vergleich A gegen B
   (100.000 Zweige: 1,7 s erster Vergleich, danach 22 ms je Seite/Suche).
4. **Speicher-Benchmark und Export.** Parquet-Export (ZSTD, Manifest, Prüfsummen, unveränderlich) und Vergleich
   SQLite gegen DuckDB/Parquet für die Abfragen aus Abschnitt 5. *Abnahme:* Messbericht und Entscheidung E2.
   **Erledigt 2026-11-07** (Tests: `backend/tests/test_archive.py`; Benchmark: `backend/tests/storage_benchmark.py`;
   Bericht und Entscheidung: `docs/STORAGE.md`): Archiv je Analyse (100.000 Elemente: 2.070 MB SQLite → 126 MB
   Parquet in 21 s; Jahreslauf 231 → 60 MB). Schlüsselzugriffe: SQLite < 1 ms, DuckDB 2–8 ms; Scans eines ganzen
   Laufs: DuckDB 4–100× schneller (z. B. 3,7 s → 35 ms). Hochrechnung Zielgröße: SQLite ≈ 65 GB je Jahreslauf,
   Parquet ≈ 10–21 GB. Kalter Plattencache nicht messbar ohne Adminrechte.
5. **Mehrbenutzer-Konzept** (nur nach E1): Katalogschema (DDL, Schlüssel, Indizes), sichere Veröffentlichung auf
   SMB/NFS (temporär schreiben, prüfen, atomar veröffentlichen, `READY`), Rechte, Lasttests mit 10/25/50 Nutzern.
6. **CGMES-Verträge** (Weg B/C): Ein-/Ausgabeformate, Normalisierung, Fehlerfälle, Integrationstests mit
   synthetischen CGMES-Daten.

---

## 9. Nicht-Ziele

- Keine Netzberechnung im Dashboard, keine Nachbildung der main.py-PDF-Bewertung.
- Kein Neubau des Frontends in anderer Technik.
- Keine Infrastruktur (Datenbankserver, Dienste, Ports) ohne Entscheidung E1.
- Keine echten vertraulichen Netzdaten in Tests oder Beispielen.

---

## 10. Liefererwartung je Phase

Trenne in jedem Bericht: **vorhanden**, **geändert**, **neu**, **Annahmen**, **offene Entscheidungen**,
**Messwerte**. Diagramme als Mermaid in der Doku. Keine Erfolgsmeldung ohne ausgeführte Tests und Messung.
