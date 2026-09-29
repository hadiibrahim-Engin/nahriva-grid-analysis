# Validierung

Stand: 29.09.2026.

| Prüfung | Ergebnis |
|---|---|
| Backend Ruff | bestanden |
| Backend pytest | 184 Tests bestanden, einschließlich übernommener FDWH-/DuckDB-/ETL-Tests |
| TypeScript `tsc -b` | bestanden |
| ESLint | bestanden |
| Frontend Node-Tests | 2 Tests bestanden |
| Vite Production-Build | bestanden; ECharts separat/lazy geladen |
| npm audit | 0 bekannte Schwachstellen |
| Production-Smoke-Test | echter Uvicorn-Prozess, temporäre SQLite-Datei, lokale Anmeldung, JWT-Pflicht, Query und CSV bestanden |
| Browser Chrome | Vergleich, Elementreferenz, Einzelfilter, CSV-Download, Empty State, Messgrößenwechsel, URL-Persistenz und Navigation bestanden |
| Responsive | 1440 px Desktop und 390 px Smartphone geprüft; kein horizontaler Seitenüberlauf nach Chart-Resize |
| Browser Runtime | keine JavaScript-Laufzeitausnahmen im Smoke-Test |
| Kartenbereinigung | keine MapLibre-/Leaflet-Abhängigkeiten, Kartenkomponenten oder Topologierouten in aktiven Quellen |
| Quellprojekt | ursprünglicher Git-Status unverändert |

`bash scripts/check.sh` führt Backend- und Frontend-Prüfungen aus.
`backend/.venv/bin/python scripts/smoke_production.py` prüft den echten Produktionsmodus.
`npm audit` benötigt Registry-Zugriff; eine Sandbox-DNS-Sperre wurde durch den autorisierten
separaten Audit-Lauf aufgelöst, nicht als bestandener Audit übergangen.

Browser-Smoke mit installiertem Playwright CLI:

```bash
mkdir -p output/playwright
playwright-cli -s=grid-analysis open http://127.0.0.1:5186 --browser chrome
playwright-cli -s=grid-analysis run-code --filename=scripts/browser-smoke.js
```

Der Test verwendet die gekennzeichneten Demo-Runs. Screenshots/Downloads sind lokale,
ignorierte Prüfartefakte unter `output/playwright/`. Die mobile Prüfung wartet auf den
ResizeObserver des Charts, bevor die Seitengröße beurteilt wird.

## Grenzen der Abnahme

- Kein Live-Oracle-Test: keine konfigurierte erreichbare FDWH-Instanz und keine Credentials.
  SQL-/Service-/Routing-/Replika-Verhalten ist durch die übernommenen Tests geprüft.
- Keine PowerFactory-Bridge oder Prüfung mit einer realen PowerFactory-Sitzung.
- Docker ist nicht installiert; Container-Build nicht ausgeführt. Native Production-Auslieferung geprüft.
- Übernommene DuckDB-ETL-Tests und Starlette/httpx melden Deprecation-Warnungen;
  diese sind keine Testfehler und können separat modernisiert werden.
- Kein Lasttest für große produktive Simulationsbestände. Explizite Abfragelimits verhindern
  unbegrenzte Transfers; Batchimport/SQL-Aggregation sind mögliche spätere Erweiterungen.
