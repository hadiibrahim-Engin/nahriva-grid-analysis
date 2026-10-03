# Korrigierter Übernahmeumfang

Quelle der Oberfläche: `DashB/Api-main/frontend`. Die vorherige Umsetzung hatte
statt der Frontend-Übernahme eine neue Analyseoberfläche gebaut und FDWH übernommen.
Das entsprach nicht dem beabsichtigten Produkt und wurde korrigiert.

Übernommen sind die originale `DashboardPage`, CSS/Tailwind-Tokens, Header,
Auswahlleiste, Theme-Umschaltung, Dropdowns, Chart-Komponenten,
Diagrammvorlagen und CSV-/Ansichtsfunktionen. Das neue Outage Management wird
mit denselben vorhandenen Komponenten in diese Seite eingefügt. Die Kartenansicht
ist deaktiviert. Der ursprüngliche Chart- und Bedienaufbau bleibt bestehen.

Die API-Abstraktion verwendet nun `/api/simulation` und den Szenario-Ergebnisspeicher.
Frontend-Mockadapter werden nicht aktiviert. Source-Komponenten bleiben unabhängig
vom Quellordner; es gibt keine Laufzeit-Symlinks oder fremden Credentials.

PowerFactory-Berechnung und Ausfall-Discovery stammen aus dem benachbarten
GridLens-Projekt. Eine lokale Kopie seines Engines liegt unter
`powerfactory/gridlens_engine.py`. `analysis_worker.py` ergänzt die ausdrücklich
gewünschte Ausfallauswahl, benannte Szenarien und persistente Datenbankübergabe.
Der GridLens-Quellordner wird nicht geändert.

Die Oracle-/FDWH-/DuckDB-Module und zugehörigen dedizierten Tests/Abhängigkeiten
wurden aus diesem Projekt entfernt. SQLite-Analyse bleibt erhalten. Anmeldung, Benutzerverwaltung und Footer wurden
auf Nutzerwunsch vollständig entfernt. Das Dashboard lädt jede Simulationsreihe
ohne Zeitfilter. Der native Einstieg ist `powerfactory/start_assessment.py`.
