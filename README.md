# Outage Assessment

Lokales Dashboard für einen Nutzer auf der PowerFactory-VM. Die Diagramme,
Auswahlleiste und Themes stammen aus `DashB/Api-main/frontend`. Anmeldung,
Benutzerverwaltung, Footer und Dashboard-Datumsfilter sind entfernt. Jeder Plot
zeigt die vollständige gespeicherte Simulationsreihe seiner Auswahl.

## Mac: sofort mit einer kleinen Dummy-QDS-Datenbank testen

Voraussetzungen: Node.js >=22.13, npm und uv.

Im Finder **`start-demo.command` doppelklicken**, oder im Projektordner:

```bash
./start-demo.command
```

Der Starter synchronisiert Python-Abhängigkeiten, installiert npm-Abhängigkeiten
bei Bedarf, baut das Frontend, erstellt eine SQLite-Datei mit Dummy-QDS-Ergebnissen
und öffnet den Browser. Der lokale Port wird automatisch gewählt; die URL steht
im Terminal. **Ctrl+C** beendet den gestarteten Server.

Testdaten: drei benannte Freischaltszenarien mit jeweils REF und OUTAGE, sieben
Tage mit 15-Minuten-Schritten, Leitungen, Trafo und Sammelschienen. Je Messreihe
werden alle 672 Punkte gespeichert. Sie sind im Dashboard als synthetisch markiert.
Standarddatei: `backend/data/outage-assessment-demo.sqlite3`. Wiederholte Starts
verwenden vorhandene Dummy-Daten; andere Ergebnisse werden nicht überschrieben.

Eigene Testdatei oder fester Port:

```bash
./start-demo.command --db /tmp/assessment-test.sqlite3 --port 18017
```

Unter **Szenario** REF auswählen, dann Betriebsmittel und Messgröße wählen und
**Hinzufügen** drücken. Danach OUTAGE desselben Szenarios/Betriebsmittels hinzufügen.
Die ursprünglichen DashB-Plots zeigen beide vollständigen Reihen. Unter
**Szenariodetails** stehen die gespeicherten Ausfallfenster und der Datenbankpfad.

## Auf Windows vorbereiten

`start-app.cmd` richtet Backend und Frontend-Abhängigkeiten ein und startet die
Entwicklungsansicht. Für den Start aus PowerFactory zusätzlich einmal im
Frontend-Ordner `npm run build` ausführen. Die Backend-Umgebung liegt unter
`backend/.venv/Scripts/python.exe`; PowerFactory verwendet sie für den separaten
Dashboard-Prozess, während die QDS selbst in PowerFactory läuft.

## Aus PowerFactory starten und berechnen

Ein externes ComPython-Skript **Outage Assessment** anlegen und auf
`powerfactory/start_assessment.py` verweisen. Oben in dieser Datei konfigurieren:

```python
DATABASE_DIRECTORY = r"C:\OutageAssessment\results"
DATABASE_NAME = "freischaltungen-2026.sqlite3"
SCENARIOS = None
DASHBOARD_PORT = 0
```

`SCENARIOS=None` berechnet jedes auswertbare Planned-Outage-Objekt im aktiven
QDS-Zeitraum einzeln unter seinem vorhandenen Namen. Alternativ benannte
Kombinationen angeben:

```python
SCENARIOS = [
    {"name": "Freischaltung Nord", "outages": ["Wartung Leitung Nord"]},
    {"name": "Nord mit Trafo", "outages": ["Wartung Leitung Nord", "Wartung Trafo Nord"]},
]
```

Bei mehrdeutigen Ausfallnamen vollständige PowerFactory-Objektpfade verwenden.
Simulationstart/-ende, Schrittweite, Profile und Ergebnisvariablen werden im
aktiven `ComStatsim` eingestellt. Das Skript berechnet pro Szenario REF und OUTAGE,
stellt den nativen Zustand wieder her, speichert beide Läufe lokal und öffnet
anschließend das Dashboard für genau diese Datenbank. Es erzeugt keine
PowerFactory-`IntScenario`-Objekte.

Die Anwendung hat keinen Login. Der Dashboard-Server bindet lokal an `127.0.0.1`.
Nach dem ComPython-Aufruf bleibt er für die Visualisierung aktiv. URL, PID und Log
stehen neben der Datenbank in `<name>.dashboard.json` bzw. `<name>.dashboard.log`.
Zum Beenden unter Windows: `Stop-Process -Id <PID>`.

## Entwicklung und Prüfungen

```bash
bash scripts/dev.sh
bash scripts/check.sh
backend/.venv/bin/python scripts/smoke_production.py
```

`scripts/dev.sh` verwendet ohne abweichendes `ANALYSIS_DB_PATH` eine leere normale
SQLite-Datei; der Mac-Dummy-Starter verwendet seine eigene Testdatei.
`backend/.env.example` zeigt die verbleibende lokale Konfiguration. Native
Worker-Funktionen benötigen nur die Standardbibliothek und das PowerFactory-Modul.

Ein echter PowerFactory-2026-Lauf auf Windows ist noch erforderlich. Die Tests
auf dem Mac verwenden Dummy-Ergebnisse und eine API-Nachbildung. Die fachliche
Zuordnung der ElmRes-Zeitstempel zu Ausfallfenstern bleibt Teil der nativen Abnahme.

[Big Picture mit Ablaufdiagrammen](BIG_PICTURE.md) ·
[PowerFactory-Details](docs/POWERFACTORY.md) · [Validierung](docs/VALIDATION.md).
