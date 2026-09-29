# Nahriva Grid Analysis

Eigenständiges technisches Analyse-Dashboard auf Basis von DashB. Keine Kartenansicht,
keine Kartenbibliotheken und keine Verbindung zum Quellprojekt zur Laufzeit.

React 19, TypeScript, Vite 8, ECharts 6 und FastAPI/Pydantic 2. Simulationsergebnisse
liegen in einem separaten SQLite-Modell; der bestehende Oracle/FDWH-Adapter mit
optionaler DuckDB-Lesereplik bleibt erhalten. Genaue Versionen: `frontend/package-lock.json`
und `backend/uv.lock`.

## Lokal starten

Voraussetzungen: Node >=22.13, Python 3.12 und [uv](https://docs.astral.sh/uv/).
Vom Projektstamm aus:

```bash
cd backend
uv sync --frozen --extra dev --extra duckdb --python 3.12
cd ../frontend
npm ci
cd ..
bash scripts/dev.sh
```

Dashboard: **http://127.0.0.1:5186** · API: **http://127.0.0.1:8016** · OpenAPI: `/openapi.json`.
`API_PORT` und `FRONTEND_PORT` lassen sich für `scripts/dev.sh` überschreiben.
Ohne `.env` läuft ausschließlich der gekennzeichnete Demomodus mit zwei synthetischen Runs;
kein Oracle-Zugang und keine lokale Datenbankdatei sind dafür nötig. Die Daten stammen
nicht aus einer echten PowerFactory-Berechnung. Ctrl+C beendet beide Entwicklungsserver.

## Funktionen

- Gemeinsame Filter für Run, Messgröße, UTC-Zeitfenster, Elementtyp, Namen/ID und Einzelelement.
- Mittelwert, Minimum/Maximum, Standardabweichung, P95, fehlende Werte und Grenzwertverletzungen.
- Zeitreihe mit Zoom, Werteverteilung und empirische Dauerlinie.
- Vergleich zweier Runs im selben Projekt anhand identischer Element-IDs und UTC-Zeitstempel.
- Sortierbare, paginierte Elementtabelle; strukturierte Elementreferenz und CSV-Export.
- Filter bleiben in der URL erhalten; Loading-, Empty-, Fehler- und Authentifizierungszustände.
- Separater FDWH-Explorer für Oracle-Rohdaten mit Cursor-Paginierung und bewusst gewähltem Stundenmittel.
- Originale FDWH-Analyse-Endpunkte einschließlich Heatmap, Korrelation, Qualität und Excel/PDF-Export.

## Eigene Ergebnisse ohne Oracle verwenden

```bash
cd backend
cp .env.example .env
.venv/bin/python scripts/import_results.py ../docs/example-run.json --database data/analysis.sqlite3
.venv/bin/python scripts/hash_password.py
```

In der ignorierten `backend/.env` konfigurieren:

```dotenv
ANALYSIS_MODE=sqlite
AUTH_BACKEND=local
LOCAL_USERNAME=analyst
LOCAL_PASSWORD_HASH=<Ausgabe von hash_password.py>
SECRET_KEY=<zufälliger Schlüssel mit mindestens 32 Zeichen>
```

Schlüssel erzeugen: `.venv/bin/python -c "import secrets; print(secrets.token_hex(32))"`.
Backend neu starten und anmelden. Ein lokales Konto ist eine einfache Einzelkonto-Option,
keine Benutzerverwaltung. Bestehende JWT- und Rate-Limit-Mechanismen werden weitergenutzt.

Eigene JSON-Dateien müssen [dem Importvertrag](docs/run-bundle.schema.json) entsprechen.
[Beispiel](docs/example-run.json) · [PowerFactory-Vorbereitung](docs/POWERFACTORY.md).
Importe sind atomar, additiv und lehnen doppelte Run-IDs ab. Kein `REPLACE`, kein Löschen
bestehender Runs. SQLite-Datenbanken, reale Ergebnisdateien und Credentials nicht versionieren.
`ANALYSIS_DB_PATH` überschreibt den Speicherort. Im SQLite-Modus werden **keine** Demo-Runs angelegt.

## Vorhandene Oracle-Daten verwenden

In `backend/.env` `AUTH_BACKEND=oracle`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
`DB_PASSWORD` setzen. Login prüft persönliche Oracle-Zugangsdaten; Analyseabfragen verwenden
den Serviceaccount. Dieser benötigt ausschließlich Leserechte auf die vorhandenen FDWH-Views.
Für eine lokale Anmeldung mit separatem Oracle-Serviceaccount ist `AUTH_BACKEND=local` möglich.

Übernommen: `FDWHRepository`, SQLAlchemy-Pooling, parametrisierte Abfragen, Stammdaten-,
Zeitreihen- und Analyse-Services. Messgrößen: P/MW, Q/Mvar, S/MVA, U/kV, I/A.
Die bestehenden Oracle-Tabellen werden weder migriert noch verändert.

DuckDB bleibt optional: `DUCKDB_ENABLED`, `DUCKDB_PATH` und `DUCKDB_FALLBACK_TO_ORACLE`.
Sync-Scripts unter `backend/scripts/duckdb_*.py`. Native Oracle-Rohdaten werden weiterhin
nicht unbemerkt durch aggregierte Replikdaten ersetzt. Ein Live-Test benötigt Zugriff auf die
reale FDWH-Instanz; er war in der Entwicklungsumgebung nicht möglich.

## Prüfen und Production-Build

```bash
bash scripts/check.sh
backend/.venv/bin/python scripts/smoke_production.py
```

Der zweite Befehl startet kurz einen echten Production-Server mit temporärer SQL-Datenbank
und zufällig erzeugten Zugangsdaten. Er prüft SPA-Auslieferung, Readiness, Login,
Zugriffsschutz, Analyse und Export und beendet den Server anschließend.

Für die produktive Auslieferung:

```bash
cd frontend
npm ci
npm run build
cd ../backend
uv sync --frozen --no-dev --python 3.12
# .env: APP_ENV=production, ANALYSIS_MODE=sqlite, SECRET_KEY und Auth-Konfiguration setzen
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8016
```

FastAPI liefert `frontend/dist` und API vom selben Origin aus. Ein Reverse Proxy kann TLS
terminieren. CORS ist standardmäßig aus; `CORS_ORIGINS` erlaubt bei Bedarf konkrete Origins.
`VITE_API_BASE_URL` konfiguriert einen abweichenden API-Origin beim Frontend-Build;
`VITE_API_PROXY_TARGET` ist nur für den Vite-Entwicklungsproxy bestimmt.
`/api/health` prüft den Prozess, `/api/health/ready` die Analyse-Datenbank und eine konfigurierte
Oracle-Verbindung. Produktionsmodus lehnt Demodaten und fehlende/kurze JWT-Schlüssel ab.

Ein Dockerfile ist als alternative Verpackung enthalten; für Laufzeit-Konfiguration und
persistente SQLite-Daten ein Env-File und `/data`-Volume verwenden. Docker war hier nicht
installiert; der Container-Build wurde nicht ausgeführt. Die native Production-Auslieferung
wurde geprüft.

## Struktur und Dokumentation

```text
frontend/src/
  api/                    typisierte HTTP-Abstraktion, Timeout, Auth
  hooks/useResource.ts    abbrechbare Abfragen; keine veralteten Filterantworten
  pages/                  Simulation, FDWH, Datenquellen
  components/             Filterauswertung, KPIs, Charts, Tabelle, Elementdetails
backend/app/
  analysis/               neues Modell, Migration, Repository, Service, REST
  api/routes/             bestehende FDWH-, Auth-, Export- und Metrics-Endpunkte
  repositories/           Oracle/DuckDB-Routing
  services/               bewährte FDWH-Analysen
  auth/, core/, db/       Auth, Logging, Fehler, Cache, SQL-Zugriff
```

- [Bestandsanalyse und Übernahmeentscheidungen](docs/ANALYSIS.md)
- [Architektur und Berechnungsregeln](docs/ARCHITECTURE.md)
- [PowerFactory-Vertrag und nächste Schritte](docs/POWERFACTORY.md)
- [Validierungsbericht](docs/VALIDATION.md)

Das Projekt ist ein unabhängiges Repository. Secrets, `.env`, virtuelle Umgebungen,
`node_modules`, Build-Ausgaben und lokale Datenbanken werden von Git ausgeschlossen.
