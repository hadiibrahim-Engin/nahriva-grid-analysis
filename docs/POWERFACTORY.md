# Vorbereitung für DIgSILENT PowerFactory

Es existiert keine aktive PowerFactory-Bridge im ursprünglichen Dashboard.
Das benachbarte Berichtsprojekt ist weder SDK noch IPC-Schnittstelle dieser Anwendung.
Dieses Projekt führt deshalb keine PowerFactory-Befehle aus und verändert keine Netzmodelle.

## Ergebnisimport

Versionierter Vertrag: `run-bundle.schema.json`; generiert aus `RunBundle`:

```bash
cd backend
.venv/bin/python scripts/export_contract.py > ../docs/run-bundle.schema.json
.venv/bin/python scripts/import_results.py ../docs/example-run.json --database data/analysis.sqlite3
```

Ein zukünftiger Exporter liefert pro Simulation einen Run mit Projekt/Study Case, den
Elementsnapshot, Messgrößen samt Einheiten/Grenzen und zeitzonenbehaftete Samples.
PowerFactory-Variablennamen werden im Exportadapter auf fachliche Messgrößen-IDs abgebildet.
Weitere Messgrößen sind ohne neue Datenbankspalten und ohne neue Diagrammkomponenten möglich.

`element.id` muss innerhalb des Projekts über Runs stabil bleiben, auch bei Namensänderungen.
Wenn die reale Schnittstelle keine stabile ID liefert, muss der Adapter eine dauerhafte
Zuordnung verwalten; ein Anzeigename ist kein Ersatz. Vollständige Objektpfade können sich
bei Umbenennungen ändern und ergänzen deshalb die ID, statt sie zu ersetzen.

## Elementauswahl

Die Tabelle bietet Details und „Elementreferenz kopieren“. Ein DOM-Ereignis
`analysis:element-selected` verwendet denselben versionierten Payload:

```json
{
  "schemaVersion": 1,
  "action": "select-element",
  "runId": "run-2026-09-21",
  "project": "Projekt",
  "studyCase": "Study Case",
  "element": {
    "id": "stabile-kennung",
    "name": "Leitung A",
    "className": "ElmLne",
    "type": "line",
    "path": "Projekt/Netzmodell/Leitung A.ElmLne"
  }
}
```

Daraus kann eine spätere Bridge den Workflow Dashboard → Elementauswahl → PowerFactory →
Markierung aufbauen. Noch erforderlich: Transportentscheidung (lokaler Dienst/IPC),
Authentifizierung und erlaubte Aktionen, verifizierte Objektauflösung, Zuordnung von
Projekt/Study Case und eine strukturierte Erfolgs-/Fehlerrückmeldung. Die konkrete
PowerFactory-Version und deren tatsächliche API werden erst bei dieser Integration festgelegt.

Zurzeit gibt es bewusst keinen funktionslosen „In PowerFactory öffnen“-Button.
Die UI benennt die fehlende Verbindung ausdrücklich.
