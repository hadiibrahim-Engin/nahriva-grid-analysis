# Start- und PowerFactory-Diagnose

`/api/health/ready` liefert Readiness und den tatsächlichen Datenbankpfad.
`/api/simulation/outage-management` zeigt Katalog, Aufträge und gespeicherte Szenarien.

Beim Mac-Test `./start-demo.command` verwenden. Im Terminal steht die URL mit
gewähltem Port. Die Testdatei ist `backend/data/outage-assessment-demo.sqlite3`.
Fehlende Messwerte im Dashboard: Betriebsmittel/Messgröße auswählen und Hinzufügen
klicken. Es wird stets die gesamte Simulation gelesen.

Native Ausführung: `powerfactory/start_assessment.py` als externes ComPython
aufrufen. Aktives Projekt, Study Case, ComStatsim-Zeitraum und ElmRes-Variablen
prüfen. `DATABASE_DIRECTORY`/`DATABASE_NAME` bestimmen dieselbe Datei, die der
Launcher anschließend an FastAPI übergibt. Es gibt keine Login-Konfiguration.

Bei Serverfehlern `<database>.dashboard.log` lesen. URL und PID stehen in
`<database>.dashboard.json`. Bei einem abgebrochenen PF-Prozess zuerst den
Originalzustand von Ausfällen, QDS-Option und Ergebnisbindung prüfen. Laufende
Aufträge werden nicht automatisch erneut ausgeführt; vorherige Ergebnisse bleiben erhalten.
