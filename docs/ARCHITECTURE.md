# Architektur von Outage Assessment

Die vollständige Code-Erklärung mit Architektur-, Batch-, Wiederherstellungs-,
Datenbank-, Dashboard- und Mac-Test-Diagrammen steht in [BIG_PICTURE.md](../BIG_PICTURE.md).

Der native Einstieg ist `powerfactory/start_assessment.py`. Er berechnet benannte
Freischaltszenarien über `analysis_worker.py`, speichert vollständige REF-/OUTAGE-
Reihen in der angegebenen SQLite-Datei und startet danach den lokalen Dashboard-
Prozess über `scripts/dashboard_launcher.py`.

Das ursprüngliche DashB-Frontend verwendet die `/api/simulation`-Verträge für
Szenarien, Betriebsmittel und Diagramme. Es besitzt keine Anmeldung und keinen
Datumsfilter. Rohdatenabfragen ohne `start`/`end` geben die gesamte gespeicherte
Reihe zurück; explizite Aggregation bleibt eine eigene Diagrammoption.

SQLite verwendet Fremdschlüssel und WAL. Pro Szenario werden Name, Ausfallauswahl,
REF, OUTAGE und alle Samples gemeinsam nach geprüfter PF-Wiederherstellung
committet. Bereits gespeicherte Ergebnisse bleiben bei einem späteren Fehler erhalten.

`scripts/start_demo.sh` und `scripts/run_demo.py` verwenden denselben Dashboard-
Launcher mit einer separaten kleinen Dummy-QDS-Datenbank auf dem Mac.
