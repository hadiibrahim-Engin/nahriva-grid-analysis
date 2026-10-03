# Validierung: Outage Assessment

Stand: 03.10.2026.

| Prüfung | Ergebnis |
|---|---|
| Backend Ruff | bestanden, einschließlich neuer Starter und PF-Batch-Skript |
| Backend pytest | 39 Tests bestanden |
| PowerFactory-API-Nachbildung | einzelne Planned Outages, eigene Kombinationen, Batch, REF/OUTAGE, vollständige Reihen, Wiederherstellung und atomare Speicherung bestanden |
| Dummy-QDS-Datenbank | drei Szenarien, sechs Ergebnisläufe, 672 Punkte je Messreihe; idempotent und keine Überschreibung fremder Ergebnisse |
| TypeScript, ESLint, Frontend-Tests | bestanden; 18 Tests, keine Lintfehler, zwei übernommene Hook-Warnungen |
| Production-Build | bestanden; Warnung zu großen übernommenen Chart-/Kartenbibliotheken |
| npm audit | 0 bekannte Schwachstellen |
| Mac-Starter | `start-demo.command --no-browser --port 18017` vollständig ausgeführt; SQLite und Server bereit |
| Launcher-/Produktions-Smoke | isolierte Datenbank, richtige Datei bei Readiness, SPA, vollständige Rohreihen ohne Start/Ende, CSV und entfernte Login-Routen bestanden |
| Browser Chrome auf macOS | Name Outage Assessment; kein Login, Footer oder Datumsfilter; alle 1.344 Punkte im REF-/OUTAGE-Overlay und Heatmap; keine JavaScript-Laufzeitausnahmen |

`bash scripts/check.sh` prüft Backend, Frontend und npm audit.
`backend/.venv/bin/python scripts/smoke_production.py` verwendet den gleichen
Launcher wie PowerFactory, mit temporärer Dummy-Datenbank.
`scripts/browser-smoke.js` setzt die eigene Dummy-QDS-Datenbank voraus.
Screenshot: `output/playwright/outage-assessment.png` (ignoriertes lokales Artefakt).

## Noch offene native Abnahme

- Kein echter PowerFactory-2026-Lauf auf diesem Mac. Die QDS-Abnahme benötigt Windows.
- ElmRes-Zeitstempel vs. Intervallende und Planned-Outage-Fenster müssen dort fachlich
  geprüft werden; die Anwendung nimmt keine automatische Verschiebung vor.
- Windows-Prozessstart und Browseröffnung aus der echten ComPython-Umgebung bleiben
  zu prüfen. Der portable Dashboard-Launcher ist auf macOS geprüft.
- Nicht sämtliche Diagrammvorlagen/WebGL-Pfade und kein großer produktiver Lasttest.
- Starlette/httpx meldet eine Deprecation-Warnung; Tests bestehen.

[Code und Ablaufdiagramme](../BIG_PICTURE.md).
