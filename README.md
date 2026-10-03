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

Testdaten: acht benannte Freischaltszenarien mit jeweils REF und OUTAGE, sieben
Tage mit 15-Minuten-Schritten, acht Leitungen, zwei Trafos, drei Sammelschienen sowie
synthetische LODF-Werte. Ältere Testdateien (drei Szenarien, ohne LODF) bleiben
lesbar; zum Neuaufbau die Datei löschen. Je Messreihe
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

## Auswertung und Freischaltbewertung

Standardansicht ist die **Zusammenfassung**: Kennzahlen, Freigabe-Bewertung je Szenario
(zulässig, bedingt, nicht zulässig, mit Begründung), Verlauf des gewählten Szenarios, Spannung
der Sammelschienen, Matrix aller Betriebsmittel (Leitungen und Transformatoren) und
Vergleichsgrafiken. Eine Navigationsleiste führt in dieser Reihenfolge durch die Abschnitte.

- **Wenig Text:** Erklärungen sind aus. Je Karte öffnet **i** den Hinweis, **Erläuterungen**
  blendet alle ein.
- **Große Datenbanken:** Die Daten laden Szenario für Szenario, schwere Abschnitte erst beim
  Scrollen dorthin.
- Zeitreihen-Overlay, Heatmap und Peak Demand sind keine Standardansichten mehr; sie lassen sich
  unter der Zusammenfassung hinzufügen.
- Die Vergleichsgrafiken lassen sich auch über **Diagramm hinzufügen → Szenarioauswertung** erzeugen
  (Anzahl und Betriebsmitteltyp wählbar).
- Schwellen und Kriterien stehen zentral in `frontend/src/config/`.

Definitionen, Kriterien, LODF, API und Anpassung: [docs/ASSESSMENT.md](docs/ASSESSMENT.md).

## Vorhandene Ergebnisdatenbank auswählen

Im Header den runden Datenbank-Button (Tooltip **Datenbank hinzufügen**) anklicken und den absoluten SQLite-Dateipfad
auf dem Rechner des Dashboard-Servers eingeben. **Datenbank laden** prüft die
vorhandene Datei und lädt das Dashboard mit ihren Ergebnissen neu. Bei ungültigen
Pfaden bleibt die bisherige Datenbank aktiv. Die Auswahl gilt für diesen
Server-Prozess; beim nächsten Start gilt wieder der angegebene Startpfad.

Auf dem Mac direkt mit einer bestehenden Datenbank starten:

```bash
./start-dashboard.command --db /absoluter/pfad/ergebnisse.sqlite3
```

Per Doppelklick fragt dieser Starter den Pfad im Terminal ab. Er erzeugt keine
Dummy-Daten. Der PowerFactory-Starter verwendet weiterhin `DATABASE_DIRECTORY`
und `DATABASE_NAME`. Logo, Query Monitor sowie CSV-/PDF-/Teilen-Buttons sind aus
dem Dashboard entfernt.

Die visuelle Überarbeitung verwendet ausschließlich Light-Mode-CSS: bestehende
Variablen, weiße Cards, dezente Schatten, Purple für Auswahl sowie Grün/Gelb/Rot
für Status. Layout und Dark-Mode-Regeln bleiben erhalten. Alle geänderten Regeln
stehen zum Nachlesen in [docs/LIGHT_MODE.css](docs/LIGHT_MODE.css); die Anwendung
verwendet weiterhin `frontend/src/index.css`.

## Auf Windows vorbereiten

`start-app.cmd` richtet Backend und Frontend-Abhängigkeiten ein und startet die
Entwicklungsansicht. Für den Start aus PowerFactory zusätzlich einmal im
Frontend-Ordner `npm run build` ausführen. Die Backend-Umgebung liegt unter
`backend/.venv/Scripts/python.exe`; PowerFactory verwendet sie für den separaten
Dashboard-Prozess, während die QDS selbst in PowerFactory läuft.

## Aus PowerFactory starten und berechnen

Ein externes ComPython-Skript **Outage Assessment** anlegen und auf
`powerfactory/start_assessment.py` verweisen. Das ist das einzige Skript, das in PowerFactory
ausgeführt wird: Es prüft Speicher und Ordner, startet (oder nutzt) den Dashboard-Server, berechnet
die Szenarien nacheinander und speichert jedes sofort. Das Dashboard zeigt sie ohne Neuladen, auch
auf anderen PCs im Netz (die Adresse steht im PowerFactory-Ausgabefenster).

`SCENARIOS=None` berechnet jedes auswertbare Planned-Outage-Objekt im aktiven QDS-Zeitraum einzeln
unter seinem vorhandenen Namen. Alternativ benannte Kombinationen in der Skriptdatei angeben:

```python
SCENARIOS = [
    {"name": "Freischaltung Nord", "outages": ["Wartung Leitung Nord"]},
    {"name": "Nord mit Trafo", "outages": ["Wartung Leitung Nord", "Wartung Trafo Nord"]},
]
```

Bei mehrdeutigen Ausfallnamen vollständige PowerFactory-Objektpfade verwenden. Simulationszeitraum,
Schrittweite, Profile und Ergebnisvariablen kommen aus dem aktiven `ComStatsim`. Das Skript
stellt den nativen Zustand verifiziert wieder her und erzeugt keine `IntScenario`-Objekte.

Datenbank, Adresse und Port stehen in `outage-assessment.config.json`
(Vorlage: `outage-assessment.config.example.json`). Einrichtung des dauerhaften Betriebs auf dem
PowerFactory-PC (Autostart, Firewall, Release-Paket), Wartung und Fehlersuche:
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. Im Netz ist das Dashboard schreibgeschützt und ohne Anmeldung
für das interne Netz gedacht.

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

Die Übersicht „Outage Management“ zeigt die Herkunft der gespeicherten Ergebnisse:
Modell/Projekt, Studie/Study Case und die tatsächlich vom nativen
`powerfactory.__version__` gemeldete Build-Version. Neue Berechnungen speichern
diesen Kontext zusammen mit Zeitraum, QDS-Kommando und verfügbaren Netz- und
Betriebsszenarioangaben pro Szenario. Ein späterer Projektwechsel überschreibt
diese Herkunft nicht. Bei Bestandsdaten bleiben nicht gespeicherte Angaben als
„Nicht erfasst“ gekennzeichnet; Dummy-QDS verwendet keine PowerFactory-Version.

Ein echter PowerFactory-2026-Lauf auf Windows ist noch erforderlich. Die Tests
auf dem Mac verwenden Dummy-Ergebnisse und eine API-Nachbildung. Die fachliche
Zuordnung der ElmRes-Zeitstempel zu Ausfallfenstern bleibt Teil der nativen Abnahme.

[Big Picture mit Ablaufdiagrammen](BIG_PICTURE.md) ·
[PowerFactory-Details](docs/POWERFACTORY.md) · [Validierung](docs/VALIDATION.md).
