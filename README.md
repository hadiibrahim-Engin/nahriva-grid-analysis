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

Testdaten: sechs benannte Freischaltszenarien mit jeweils REF und OUTAGE, sieben
Tage mit 15-Minuten-Schritten, acht Leitungen, Trafo und Sammelschienen sowie
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

## Auswertung über alle Szenarien

Standardansicht ist nur die **Zusammenfassung**. Zeitreihen-Overlay, Heatmap und Peak
Demand Analysis sind keine Standard-Plots mehr: Unter der Zusammenfassung lassen sie
sich über **Weitere Ansichten hinzufügen** (und wieder entfernen) einblenden; weitere
Diagramme über **Eigene Diagramme**.

Es gibt **eine** Navigationsleiste: die Abschnitte der Zusammenfassung in der Lesereihenfolge
einer Bewertung (Kennzahlen, Bewertung, Verlauf, Szenariodetails, Spannung, Matrix,
Grafiken, Radar, Detailtabelle), danach die hinzugefügten Ansichten und die Diagramme.
Anzahlen stehen als kleine Zähler dabei, die Markierung folgt dem Scrollen, und ein Klick
springt zum Abschnitt und klappt eingeklappte Abschnitte auf.

Die Zusammenfassung zeigt in dieser Reihenfolge: KPI-Karten, **Szenarien im Überblick**
(je Szenario: was freigeschaltet ist, Zeitachse der Ausfallfenster über den
Simulationszeitraum, Verteilung der Leitungen auf die Auslastungsbereiche, Kennzahlen),
vier Diagramme (Auslastung je Leitung von Base bis Maximum, Überlastdauer, Änderung der
Auslastung, LODF gegen Änderung), die Line × Scenario Heatmap sowie die aufklappbare
Detailtabelle und die aufklappbaren Szenariodetails. Alle Werte bleiben als Zahl
sichtbar (Tooltips, Beschriftungen, Tabelle).

- Auslastungsbänder und Schwellen stehen zentral in
  `frontend/src/config/loadingBands.ts` (<80, 80–100, 100–110, 110–120, >120 %).
- Szenariowert = maximale OUTAGE-Auslastung im Ausfallfenster; Base = REF-Maximum
  über den gesamten Zeitraum; Δ = Szenariowert minus REF im selben Fenster in
  Prozentpunkten (pp). Eine im Szenario freigeschaltete Leitung zählt dort nicht.
- Overload Excess = max(Loading − 100 %, 0).
- **Overload Rate** bezieht sich auf den **Simulationszeitraum**: Zeit über 100 % im
  ungünstigsten Szenario geteilt durch die Länge des Simulationszeitraums (z. B. 10,5 h
  von 168 h = 6,3 %). Die Anzahl der Szenarien mit Überlastung steht getrennt daneben.
- Der Abschnitt wird nur lesend aus der SQLite-Datei aufgebaut
  (`GET /api/simulation/across-scenarios`); bestehende Berechnungen bleiben unverändert.

### Freischaltbewertung

Bewertet werden **alle Betriebsmittel** der Ergebnisse: Leitungen und Transformatoren
(2- und 3-Wickler) nach thermischer Auslastung, Sammelschienen nach Spannung. Das
Spannungsband ist zentral auf **0,90 bis 1,10 p.u.** festgelegt
(`frontend/src/config/assessment.ts`) und gilt für alle in p.u. gespeicherten Spannungen;
Ergebnisse in kV werden gegen die mit ihnen gespeicherten Grenzen beurteilt, ohne
Grenzen wird keine Verletzung abgeleitet. Ein Typfilter schränkt nur Matrix, Grafiken,
Radar und Tabelle ein; Kennzahlen, Bewertung, Verlauf und Details berücksichtigen immer alles.

Entscheidend ist die **Verursachung** gegenüber dem Referenzlauf im selben Ausfallfenster:
*verursacht* (REF ≤ 100 %, mit Freischaltung > 100 %), *verschärft* (schon > 100 %, um
mindestens 2 pp höher) oder *Vorbelastung* (unverändert). Entsprechend bei Spannung.

Je Szenario ergibt sich eine Bewertung mit Begründung (Kriterien in
`frontend/src/config/assessment.ts`):

- **Nicht zulässig:** Überlastung oder Spannungsverletzung durch die Freischaltung verursacht
  oder verschärft.
- **Bedingt zulässig:** keine neue Verletzung, aber Vorbelastung über den Grenzen, weniger
  als 5 pp thermische Reserve durch die Freischaltung, Warnbereich (≥ 80 %) neu erreicht
  oder Spannung näher als 0,02 p.u. an einer Grenze.
- **Zulässig:** sonst, mit Angabe der höchsten Auslastung und der Reserve.

Die Bewertung ist eine Entscheidungshilfe nach diesen konfigurierbaren Kriterien, keine
Freigabe. Der **Belastungsverlauf** zeigt für das gewählte Szenario die fünf höchstbelasteten
Betriebsmittel über den Simulationszeitraum mit Ausfallfenster, 80-%- und 100-%-Linie und
dem Referenzlauf (`GET /api/simulation/across-scenarios/{id}/profile`).

### LODF

`powerfactory/lodf.py` berechnet LODF **vor der ersten Simulation** aus DC-Lastflüssen
(`ComLdf`, `iopt_net=2`): je Szenario werden dessen Ausfallobjekte gemeinsam
abgeschaltet, `LODF = ΔP_Leitung / ΣP_ausgefallen,vorher` (bei mehreren Ausfällen mit
Beträgen normiert; angezeigt wird |LODF|). Die Werte stehen in `pf_lodf`, getrennt von
den Ergebnisläufen. Schlägt der Lastfluss fehl, meldet das Skript eine Warnung, rechnet
die Szenarien trotzdem und das Dashboard zeigt „nicht berechnet“. Ein echter
PowerFactory-Lauf prüft insbesondere Variablennamen `m:P:bus1`/`m:P:bushv` und die
Zuordnung der Ausfallobjekte zu Leitungen.

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
