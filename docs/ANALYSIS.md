# Bestandsanalyse vor der Implementierung

Analysiert am 29.09.2026. Ausgangspunkt: `nahriva_works/DashB`, Quell-Commit
`6134be87e2dd3629510cbbf10d054cec68dc3a53`. Bereits vorhanden waren Änderungen an
`.gitignore` und unversionierte `docs/superpowers/plans/`; diese wurden nicht angefasst.

## Identifikation im übergeordneten Ordner

Die Package-/Projektinventur umfasste DashB, ProdiLandingPage, figma, ItechProgress,
mona-user-interface, nahriva Page, parser, filetransporter, RepoFleet, biji,
windows-auto-task-runner, windows-task-scheduler und gridlens-powerfactory.
DashB ist das gesuchte Dashboard: gekoppelte React/FastAPI-Anwendung, Kartenkomponenten,
Analyse-Charts, Oracle-Abfragen und Desktop-Verpackung. Das benachbarte
`gridlens-powerfactory` ist ein eigenständiges ComPython-/Stimulsoft-Berichtsprojekt,
keine vorhandene Bridge des Dashboards. Es wird nicht verändert oder als Abhängigkeit eingebaut.

## Frontend

| Bereich | Vorhandener Stand | Entscheidung |
|---|---|---|
| Framework | React ^19.2.4, TypeScript ~5.9.3, Vite ^8.0.13 | Beibehalten, Lockdatei neu auflösen |
| Routing | react-router-dom 7, lazy Login/Dashboard/DesignDemo | Router behalten; Analyse/FDWH/Datenquellen |
| Zustand | React-Hooks, UiConfig-Context; URL/LocalStorage-Ansichten | URL-Filter + lokale Hooks; keine neue Store-Bibliothek |
| API | Axios-Client, Cache, JWT in LocalStorage, Mock-Adapter, Desktop-Overrides | Kleine fetch-Abstraktion, SessionStorage, Abbruch/Timeout; keine Frontend-Mocks |
| Styling | Tailwind 4, umfangreiche CSS-Tokens, zusätzliche UI-Bibliotheken | Bewährte dunkle Grid-Farben; fokussiertes CSS ohne parallele Token-Systeme |
| Charts | ECharts 5, ECharts GL, selbst implementierter React-Wrapper, ResizeObserver | Wrapper und Zahlenformatierung übernehmen; ECharts 6.1 wegen Audit-Befund |
| Seiten | DashboardPage 2.568 Zeilen, API-Client 1.128 Zeilen | Verantwortlichkeiten aufteilen, getrennte Komponenten |
| Tests | Node-Tests für dynamische Chart-Ableitungen | Neue Selektions-/Query-Tests, reale Browserprüfung |
| Desktop | Electron, Electron Store, gebündelte Backend-/Frontend-Kopien | Nicht übernommen; eigenständige Webanwendung |

Die Funktionalität der neuen Oberfläche stammt durchgehend aus Backend-Daten, auch im
Demomodus. Zustand und Berechnungen existieren nicht ein zweites Mal als statische UI-Attrappe.
Wiederverwendet wurden der ECharts-Lebenszyklus/ResizeObserver, Zahlenformatierung,
Exportregistrierung und Grundzüge des Grid-Designs. Alte Chart-Spezialansichten bleiben
als vorhandene Backend-Services verfügbar, wurden nicht blind als ungenutzte UI kopiert.

## Backend und SQL

FastAPI, Pydantic 2, Uvicorn, SQLAlchemy 2, python-oracledb im Thin-Modus.
Die relevanten Layer sind bereits getrennt:

- `api/routes`: Auth, Anlagen/Betriebsmittel, raw/aggregate Timeseries, Analytics, Export, Metrics, Shares.
- `services`: ComponentService (Deduplizierung/Null-IDs), TimeseriesService (raw vs aggregate,
  Cursor, Größenlimits, Metadaten), AnalyticsService (Heatmap, Spannungsband, Dauerlinie,
  Tagesprofil, Korrelation, Boxplot, Leistungsfaktor, Datenqualität, DST, Jahresprofil, Überschreitungen).
- `repositories/fdwh_repository.py`: SQL-Ausführung, Resultsets, DB-Laufzeitmessung.
- `db/queries.py`: ausschließlich gelistete Messspalten und parametrisierte Komponenten-/Zeitfilter.
- `db/database.py`: Lazy-Engine, Session-Cleanup, Pooling, Oracle-NLS und Statement-Timeout.
- `duckdb`: Dimensionen, Rohdaten-/Stunden-/Tages-Tabellen, Coverage, atomarer Replikawechsel,
  Bootstrap und Wochen-Sync; Routing fällt konfigurierbar auf Oracle zurück.
- `auth`: Oracle-Credential-Prüfung, JWT, Rollen, Login/API-Rate-Limits.
- `core`: strukturierte Logs, Request-ID, konsistente Domänenfehler, Cache, Metrics, Security-Header.

Oracle-Quelle: `FDWH.TIFAB_ODB_STAMMDATEN` und `FDWH.TIFAB_ODB_MESSWERTE`.
Schlüssel: ANLAGENNUMMER/FELDNUMMER; Messzeit: LOKALZEIT. Spaltenzuordnung:
MW→P, BMW→Q, S→S, UUW→U, STROMWERT→I. Kein eigenes ORM-Schema und keine vorhandenen
Simulation-Run-/Study-Case-/PowerFactory-Pfad-Felder.

DuckDB-Schema: `dim_anlage`, `dim_betriebsmittel`, `dim_measurement_type`,
`measurements_15min_recent`, `measurements_hourly`, `measurements_daily`,
`sync_status`, `duckdb_coverage`. Es ist eine FDWH-Lesereplik, kein Simulationsergebnisspeicher.

Keine reale Backend-`.env` vorhanden. Lokal liegt `data/mock_big.duckdb` (424 MB),
explizit ein synthetischer Mock-Datensatz; außerdem statische Mock-Netztopologie.
Diese Dateien sind keine verifizierte Live-Datenquelle und wurden nicht in das neue Repo kopiert.

## Kartenfunktion: vollständig ausgeschlossen

Nicht übernommen wurden `src/map/**`, `GridMapLibre`, `GridMapChart`,
`gridMockData`, `gridTopology`, `GeoContextBar`, `AnimatedDottedMap`,
`facilityMatcher`, Topologie-Validator/Worker, Karten-CSS, Grid-JSON/GeoJSON,
OSM-Generator, `build_grid_topology.py`, Radar-/Kartenhintergründe und Map-States der alten Seite.
Entfallen: `maplibre-gl`, `leaflet`, `react-leaflet`, `@types/leaflet` und Karten-Bundlegruppen.
Es gibt im normalen FastAPI-Backend keine exklusiven Kartenrouten/-SQL-Abfragen:
Die Karte lud statische Topologiedateien. Generatorscripts wurden entfernt;
allgemeine Anlagen-/Betriebsmittelabfragen bleiben für die Datenanalyse erforderlich.
Heatmaps sind statistische Diagramme und keine geographische Karte.

Ebenfalls ausgeschlossen: DesignDemo, aufwendige Login-Animationen, Videohintergründe,
WebGL-/3D-Charts, Desktop-Konfigurationsbrücken, Share-Snapshots, Share-SQLite-Store,
alte Frontend-Mock-Adapter sowie nicht benötigte Animation/PDF-/UI-Dependencies.
Backend-Excel/PDF-Export bleibt als vorhandene analytische Funktion erhalten.
Ungenutztes passlib/bcrypt wurde nicht übernommen; ursprünglicher Login benutzt Oracle.

## Übernommene Prüf- und Betriebsstrukturen

165 vorhandene Backend-Tests zu Services, SQL/Replika, ETL, Cache, Rate-Limits,
Security-Headern, Metrics und Diagnostik wurden übernommen; Share-Tests entfallen mit dem Feature.
Originale CI: GitHub Actions (Node22/Python3.11), zusätzlich Azure-Pipelines und
Electron-/Windows/macOS-Startscripte. Bestehende Deployment-Doku referenziert auch
Docker-Artefakte; eine entsprechende aktive Container-Konfiguration lag nicht in Api-main.
Das neue Projekt erhält eigene Start-/Check-Scripts, Lockdateien und CI.

## Architekturentscheidung

FDWH-Strukturen bleiben erhalten. Neue Simulationsergebnisse ergänzen eine eigene SQL-Schicht
unter `app/analysis`, mit kleinem versioniertem Vertrag statt einer PowerFactory-SDK-Abhängigkeit.
Demodaten leben ausschließlich in einer flüchtigen SQL-Datenbank; Persistenzmodus startet leer.
Keine Quellprojekt-Symlinks, keine kopierten Secrets, keine produktiven Datenänderungen.
