# Ablauf: Berechnung und Dashboard

```mermaid
flowchart TD
    A(["Start"]) --> B{"Startweg?"}

    B -->|"PowerFactory"| C["start_assessment.py ausführen"]
    C --> D["Installation bei Bedarf vorbereiten<br/>Dashboard-Server starten oder wiederverwenden"]
    D --> CM["Fallmanager öffnen<br/>Berechnung benennen, Fälle und Optionen wählen"]
    CM --> R{"Ergebnisquelle?"}
    R -->|"Neue Berechnung"| CALC["Gewählte QDS- und/oder n-1-Läufe berechnen<br/>Geänderte PowerFactory-Einstellungen wiederherstellen und prüfen"]
    R -->|"Gespeicherter Lauf: Results"| KEPT["Vorhandene native Ergebnisse laden<br/>Keine erneute Netzberechnung"]
    CALC --> IMPORT["Native Ergebnisse fallweise importieren"]
    KEPT --> IMPORT
    IMPORT --> FIRST["Erster Planungsfall gespeichert:<br/>Dashboard im Browser öffnen"]
    IMPORT --> REST["Weitere Ergebnisse importieren<br/>Anschließend ursprüngliche Bewertung speichern"]
    FIRST --> E["Dashboard anzeigen"]
    REST -.->|"Status und Ergebnisse aktualisieren"| E

    B -->|"Manuell"| F["Dashboard mit vorhandener,<br/>gültiger SQLite-Ergebnisdatenbank starten"]
    F --> G["Lokalen Dashboard-Server starten<br/>Datenbank und zugehörige Ergebnisdateien lesen"]
    G --> E

    E --> H{"Analysen vorhanden?"}
    H -->|"Ja"| I["Analyse auswählen<br/>Standard: neueste Analyse mit Szenario"]
    H -->|"Nein"| J["Leerer Dashboard-Zustand"]
    J --> K{"Ergebnisse bereitstellen"}
    K -->|"Andere Datenbank"| DB["Vorhandene SQLite-Ergebnisdatenbank öffnen"]
    K -->|"Parquet-Archiv"| ARCHIVE["Archiv prüfen, in neue Datenbank<br/>wiederherstellen und öffnen"]
    K -->|"Native PowerFactory-Ergebnisse"| C
    DB --> H
    ARCHIVE --> H

    I --> L["Dashboard verwenden"]
    L --> M["Assessment · Scenarios · Network<br/>Assets · Compare · Charts"]

    style F fill:#dbeafe,color:#1e40af,stroke:#2563eb
    style G fill:#dbeafe,color:#1e40af,stroke:#2563eb
```

- Der manuelle Start führt keine PowerFactory-Berechnung aus. Native Ergebnisse werden über den PowerFactory-Fallmanager importiert.
- Datenbankwechsel und Archivoperationen sind nur verfügbar, wenn der Server den lokalen Dateizugriff erlaubt; im Netzwerkbetrieb sind sie standardmäßig deaktiviert.
- Bei neueren Importen gehören die SQLite-Datei und der zugehörige `.values`-Ordner zusammen. Ein vollständiges Parquet-Archiv enthält zusätzlich ein `manifest.json` und die archivierten Tabellen.
- Die ursprüngliche PowerFactory-Bewertung bleibt von der Dashboard-Bewertung mit ihren einstellbaren Grenzwerten getrennt. Bei reinen n-1-Läufen fehlen QDS-abhängige Ansichten.
