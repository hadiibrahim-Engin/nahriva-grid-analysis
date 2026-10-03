# Herkunft der PowerFactory-Funktionen

`gridlens_engine.py` ist eine unveränderte Kopie von
`gridlens-powerfactory/powerfactory/gridlens_report.py` aus dem lokalen Arbeitsstand
einschließlich der dort bereits vorhandenen Änderungen. Basis-Commit:
`cae2064b0b8b60efaa96e07c617a89585b179d81`.
SHA-256 beider Dateien beim Übernehmen:
`23797cd121b5b80ba01be23e16d52a93b608e314422f7bd5cd1e7a1379c3cb25`.

`analysis_worker.py` verwendet dessen Discovery-, ComStatsim-, ElmRes- und
Wiederherstellungsfunktionen. Der ursprüngliche Report-Publisher wird nicht gestartet.
Zur Datenbankspeicherung wird `MAX_PLOT_POINTS` zur Laufzeit auf `MAX_RESULT_ROWS`
gesetzt, damit keine Ausdünnung auf 200 Berichtspunkte erfolgt. `GRID_NAME_FILTER`
wird vom Worker übernommen und ist standardmäßig leer.

Die Dashboard-Komponenten stammen aus `DashB/Api-main/frontend`, Commit
`6134be87e2dd3629510cbbf10d054cec68dc3a53`. Änderungen betreffen die Anbindung
an Simulationsdaten, das neue Outage Management und die dazugehörigen Bezeichnungen.
Die ursprünglichen Quellprojekte werden nicht verändert.

Die Prüfung mit einer API-Nachbildung ersetzt keine native PowerFactory-Abnahme.
Insbesondere müssen Ausfallfenster und ElmRes-Zeitstempel in einem echten
PowerFactory-2026-Projekt unter Windows geprüft werden.

`start_assessment.py` ergänzt den nativen Batch-Einstieg, die konfigurierbare
Ergebnisdatei und den Start des lokalen Dashboards.
