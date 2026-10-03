# Outage Assessment — Big Picture

## 1. Zweck und Komponenten

Ein Nutzer startet Outage Assessment lokal auf seiner PowerFactory-VM. Das
ComPython-Skript berechnet Freischaltszenarien und speichert ihre Ergebnisse in
SQLite. Das Dashboard zeigt diese Ergebnisse mit den übernommenen
DashB-Diagrammen. Es gibt keine Anmeldung, keine Benutzerverwaltung, keinen
Dashboard-Footer und keinen Datumsfilter für die Plots.

```mermaid
flowchart LR
    User[Nutzer in PowerFactory] --> Entry[start_assessment.py]
    Entry --> Plan[scenario_plan: Namen und Ausfälle prüfen]
    Plan --> Batch[run_assessment: Szenarien nacheinander]
    Batch --> Worker[analysis_worker.py]
    Worker --> Engine[gridlens_engine.py]
    Engine --> PF[ComStatsim und ElmRes]
    PF --> Worker
    Worker --> Store[ScenarioStore]
    Store --> DB[(Lokale SQLite-Datei)]
    Entry --> Launcher[dashboard_launcher.py]
    Launcher --> Server[Lokaler FastAPI-Server]
    Server --> DB
    Server --> Browser[Outage Assessment im Browser]
    Browser --> Charts[DashB-Diagramme]
```

| Datei | Verantwortung |
|---|---|
| `powerfactory/start_assessment.py` | Datenbankordner/-name, Szenariodefinitionen, native Berechnung und Dashboard-Start |
| `powerfactory/analysis_worker.py` | PF-Kontext lesen, Ausfälle aktivieren, REF/OUTAGE ausführen, Zustand wiederherstellen, vollständige Reihen serialisieren |
| `powerfactory/gridlens_engine.py` | Übernommene GridLens-Helfer für native Objekte, QDS, ElmRes und Wiederherstellung |
| `backend/app/simulation/store.py` | Gemeinsamer SQLite-Vertrag für PF und Webapp; Aufträge und atomarer Szenarioimport |
| `scripts/dashboard_launcher.py` | Separaten HTTP-Prozess mit genau der angegebenen Datenbank starten und Browser öffnen |
| `backend/app/main.py` | HTTP-Prozess, Readiness, Simulation-API und statisches Frontend |
| `backend/app/simulation/routes.py` | DashB-API-Verträge auf SQLite abbilden |
| `backend/app/simulation/data.py` | Rohreihen, explizite Aggregation und Analysen |
| `frontend/src/pages/DashboardPage.tsx` | Auswahl von Szenario/Betriebsmittel/Messgröße und vollständige Ergebnisreihen |
| `frontend/src/components/OutageManagement.tsx` | Gespeicherte Szenarien und ihre Ausfallfenster erklären |
| `scripts/seed_dummy_qds.py` | Kleine synthetische QDS-Datenbank für Mac-Tests erzeugen |
| `start-demo.command` | Mac-Test per Doppelklick oder Terminal starten |

## 2. Native Ausführung in PowerFactory

In `start_assessment.py` werden `DATABASE_DIRECTORY` und `DATABASE_NAME`
konfiguriert. `SCENARIOS=None` bedeutet: jedes auswertbare Planned-Outage-Objekt
mit überlappendem QDS-Fenster bildet ein Szenario unter seinem vorhandenen Namen.
Auch ursprünglich ignorierte Ausfälle werden für ihren eigenen Lauf ausdrücklich
aktiviert. Ein Szenario kann alternativ mehrere Ausfälle unter einem eigenen
Namen kombinieren. Bei mehrdeutigen Objektnamen werden vollständige PF-Pfade benutzt.

Start, Ende, Schrittweite, Profile und Ergebnisvariablen werden im aktiven
`ComStatsim` konfiguriert. Das Dashboard übernimmt diese Dauer vollständig.

```mermaid
flowchart TD
    Start[Externes ComPython ausführen] --> Install[Backend und Frontend-Build prüfen]
    Install --> Discover[Aktives Projekt, Study Case, QDS und Planned Outages lesen]
    Discover --> Validate[Alle Szenarionamen und Ausfallreferenzen prüfen]
    Validate --> Valid{Plan gültig?}
    Valid -->|Nein| Stop[Fehler anzeigen, keine native Rechnung]
    Valid -->|Ja| Next[Nächstes benanntes Szenario]
    Next --> Job[Katalog veröffentlichen und Auftrag anlegen]
    Job --> Calc[Worker berechnet REF und OUTAGE]
    Calc --> Saved{Wiederherstellung und Import erfolgreich?}
    Saved -->|Nein| Fail[Auftrag fehlgeschlagen, Lauf stoppen]
    Saved -->|Ja| More{Weitere Szenarien?}
    More -->|Ja| Next
    More -->|Nein| Launch[Dashboard für diese SQLite-Datei starten]
    Launch --> View[Browser mit gespeicherten Szenarien öffnen]
```

Bereits erfolgreich gespeicherte Szenarien bleiben erhalten, falls eine spätere
Berechnung fehlschlägt. Jeder erneute Batch erzeugt neue Ergebnisläufe mit eigenen
IDs; bestehende Ergebnisse werden nicht überschrieben. Es werden keine
`IntScenario`-Objekte erzeugt: Szenarioname und Ausfallkombination gehören zum
persistierten Assessment-Ergebnis.

## 3. REF/OUTAGE und Wiederherstellung

`calculate()` verwendet kopierte ElmRes-Objekte mit der vorhandenen
Variablenauswahl. Die Eingriffe sind zeitlich begrenzt und werden geprüft
zurückgenommen. Das Script benötigt im nativen PF-Prozess nur die
Standardbibliothek und das PowerFactory-Modul; FastAPI läuft in einem eigenen
Python-Prozess mit der Backend-Umgebung.

```mermaid
sequenceDiagram
    participant Batch as start_assessment
    participant Worker as analysis_worker
    participant PF as PowerFactory
    participant DB as SQLite
    Batch->>DB: Auftrag mit Name, Auswahl und Katalog-Fingerprint
    Worker->>DB: Auftrag atomar übernehmen
    Worker->>PF: Projekt und QDS-Kontext erneut prüfen
    Worker->>PF: Outage-Flags, iopt_maint, Study-Zeit und ElmRes-Bindung sichern
    Worker->>PF: Ausgewählte outserv=0, übrige outserv=1
    Worker->>PF: REF mit iopt_maint=0 auf ElmRes-Kopie
    PF-->>Worker: Vollständige Ergebniszeilen
    Worker->>PF: Study-Zeit wiederherstellen
    Worker->>PF: OUTAGE mit iopt_maint=1 auf ElmRes-Kopie
    PF-->>Worker: Vollständige Ergebniszeilen
    Worker->>Worker: Zeitachsen und Ergebnisgrenzen prüfen
    Worker->>PF: Alle Flags, Study-Zeit und Ergebnisbindung zurücksetzen
    Worker->>PF: Temporäre ElmRes-Kopien entfernen
    Worker->>DB: Szenario plus beide Ergebnisläufe gemeinsam committen
    DB-->>Batch: Szenario gespeichert
```

```mermaid
flowchart TD
    Capture[Ursprungszustand erfassen] --> Run[REF und OUTAGE berechnen]
    Run --> Finally[finally: Wiederherstellung versuchen]
    Finally --> Restore{Vollständig verifiziert?}
    Restore -->|Nein| Reject[Keine Ergebnisse speichern, PF-Zustand manuell prüfen]
    Restore -->|Ja| CalcOK{Berechnung und Zeitachsen gültig?}
    CalcOK -->|Nein| Failed[Auftrag als fehlgeschlagen markieren]
    CalcOK -->|Ja| Tx[SQLite-Transaktion: Szenario, REF, OUTAGE und Samples]
    Tx --> DBOK{Import erfolgreich?}
    DBOK -->|Nein| Rollback[Gesamten Szenarioimport zurückrollen]
    DBOK -->|Ja| Done[Auftrag abgeschlossen]
```

Ein bereits laufender Auftrag wird nicht automatisch erneut ausgeführt. Nach
Abbruch des PF-Prozesses ist der native Zustand zu prüfen, bevor der betreffende
Auftrag ausdrücklich bereinigt wird.

## 4. Datenbankmodell und Identität

```mermaid
erDiagram
    PF_CATALOG {
        int id PK
        string payload
        string updated_at
    }
    PF_JOBS {
        string id PK
        string kind
        string payload
        string status
        string message
    }
    PF_SCENARIOS {
        string id PK,FK
        string name
        string project
        string study_case
        string outages
    }
    PF_SCENARIO_RUNS {
        string scenario_id PK,FK
        string run_id PK,FK
        string kind
    }
    ANALYSIS_RUNS {
        string id PK
        string name
        string source
        string status
    }
    ANALYSIS_ELEMENTS {
        string run_id PK,FK
        string id PK
        string name
        string className
        string path
    }
    ANALYSIS_METRICS {
        string run_id PK,FK
        string id PK
        string unit
    }
    ANALYSIS_SAMPLES {
        string run_id PK,FK
        string element_id PK,FK
        string metric_id PK,FK
        string timestamp PK
        float value
        string status
    }
    PF_ELEMENT_LIMITS {
        string run_id PK,FK
        string element_id PK,FK
        string metric_id PK
        float lower
        float upper
    }
    UI_SHARES {
        string id PK
        string kind
        string payload
    }
    PF_JOBS ||--o| PF_SCENARIOS : produces
    PF_SCENARIOS ||--|{ PF_SCENARIO_RUNS : contains
    ANALYSIS_RUNS ||--o| PF_SCENARIO_RUNS : linked
    ANALYSIS_RUNS ||--|{ ANALYSIS_ELEMENTS : contains
    ANALYSIS_RUNS ||--|{ ANALYSIS_METRICS : contains
    ANALYSIS_ELEMENTS ||--o{ ANALYSIS_SAMPLES : measured
    ANALYSIS_METRICS ||--o{ ANALYSIS_SAMPLES : describes
    ANALYSIS_ELEMENTS ||--o{ PF_ELEMENT_LIMITS : limits
```

SQLite verwendet WAL und Fremdschlüssel. Der Element-Hash stammt aus Projektpfad
und Objektpfad. Die Frontend-Kennung kodiert zusätzlich die Lauf-ID: dasselbe
Betriebsmittel in REF und OUTAGE lässt sich dadurch getrennt auswählen. Diagramm-
legenden enthalten Szenarioname, Laufart und Betriebsmittel. Umbenennungen in PF
ändern die pfadbasierte Identität.

## 5. Dashboard und vollständige Plots

```mermaid
sequenceDiagram
    participant User as Nutzer
    participant UI as Dashboard
    participant API as Simulation-API
    participant DB as SQLite
    UI->>API: GET facilities
    API->>DB: Gespeicherte Ergebnisläufe lesen
    API-->>UI: Szenarioname plus REF oder OUTAGE
    User->>UI: Szenario, Betriebsmittel, Messgröße, Hinzufügen
    UI->>API: GET timeseries/raw ohne start/end
    API->>DB: Alle Samples dieser Auswahl in Zeitreihenfolge
    API-->>UI: Rohwerte und optional next_cursor
    loop Weitere Seiten vorhanden
        UI->>API: Folgeseite mit Cursor
        API-->>UI: Weitere Rohwerte
    end
    UI->>UI: Vollständige Reihe an DashB-Chart übergeben
    User->>UI: Zweiten Szenariolauf hinzufügen
    UI->>UI: REF und OUTAGE im Overlay anzeigen
```

Es gibt keinen versteckten Filter auf die letzten 30 Tage und keinen
Dashboard-Zeitraum. Alte Simulationen werden ebenfalls vollständig angezeigt.
Chart-Zoom ist eine Ansichtsfunktion. Zusätzliche aggregierte Diagramme werden
nur auf ausdrückliche Auswahl erzeugt. Fehlende/fehlgeschlagene Werte werden
nicht als Nullen erfunden. Übergröße wird mit einem Fehler gemeldet, nicht still
abgeschnitten. Die native ElmRes-Auslese begrenzt ein Resultat auf 35.040 Zeilen;
die Simulation-API akzeptiert bis 200.000 Rohwerte je Auswahl und paginiert
mit maximal 50.000 Werten je Seite.

## 6. Dashboard-Prozess starten

```mermaid
flowchart TD
    DB[Ergebnisdatenbank angegeben] --> Check[Backend-Python und frontend/dist prüfen]
    Check --> Port[Freien localhost-Port bestimmen]
    Port --> Env[ANALYSIS_DB_PATH auf exakt diese Datei setzen]
    Env --> Spawn[Uvicorn als eigenen Prozess starten]
    Spawn --> Ready[Readiness pollen und Datenbankpfad abgleichen]
    Ready --> OK{Server bereit und richtige DB?}
    OK -->|Nein| Stop[Prozess stoppen, Logdatei melden]
    OK -->|Ja| Record[URL und PID neben Datenbank speichern]
    Record --> Open[Browser öffnen]
```

Der HTTP-Prozess bindet an `127.0.0.1`. Der Standardport `0` bedeutet automatische
Portwahl. Neben der Datenbank entstehen `<name>.dashboard.log` und
`<name>.dashboard.json` mit URL und PID. Der native Dashboard-Prozess läuft nach
Ende des ComPython-Skripts weiter. Er kann über seine PID beendet werden. Der
Mac-Starter hält dagegen sein Terminal offen und beendet seinen Server bei Ctrl+C.

## 7. Mac-Test ohne PowerFactory

```mermaid
flowchart TD
    Command[start-demo.command] --> Setup[uv sync und npm ci bei geänderter Lockdatei]
    Setup --> Build[Frontend bauen]
    Build --> Seed[seed_dummy_qds.py]
    Seed --> Exists{Datenbank schon befüllt?}
    Exists -->|Eigene Dummy-Version| Reuse[Vorhandene Testdaten wiederverwenden]
    Exists -->|Fremde Ergebnisse| Abort[Abbrechen, andere Datenbankdatei wählen]
    Exists -->|Leer| Generate[Drei benannte Szenarien: je REF und OUTAGE]
    Generate --> Store[672 Zeitpunkte pro Messreihe speichern]
    Store --> Launch[Lokales Dashboard starten]
    Reuse --> Launch
    Launch --> Browser[Dummy-Kennzeichnung und echte SQLite-Abfragen]
    Browser --> Stop[Ctrl+C beendet den eigenen Server]
```

Die Testdaten enthalten Leitungen, einen Transformator, Sammelschienen,
Auslastungen, Spannungen sowie P/Q/Strom. Ausfallbedingte Unterschiede entstehen
nur in den jeweiligen Dummy-Ausfallfenstern. Sie sind synthetisch und werden als
`Dummy QDS (synthetic)` gespeichert. Standarddatei:
`backend/data/outage-assessment-demo.sqlite3`. Der echte PF-Standard verwendet
`backend/data/outage-assessment.sqlite3`.

## 8. Tests und reale Abnahme

Worker-Tests verwenden eine native API-Nachbildung und prüfen einzelne Ausfälle,
benannte Kombinationen, Batch-Verarbeitung, Zustandswiederherstellung und atomare
Persistenz. Der Produktions-Smoke startet den gleichen Dashboard-Launcher mit
isolierter Dummy-Datenbank. Browserprüfungen kontrollieren vollständige Reihen
auch mit alten Zeitstempeln sowie die entfernte Anmeldung, den Footer und den
Datumsfilter.

Ein echter PowerFactory-2026-Lauf auf Windows bleibt erforderlich. Insbesondere
muss die im GridLens-Projekt offene Zuordnung zwischen ElmRes-Zeitstempel,
Intervallende und Planned-Outage-Fenster fachlich geprüft werden. Die Anwendung
verschiebt diese Zeitstempel nicht automatisch.
