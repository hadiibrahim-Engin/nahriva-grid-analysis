# PowerFactory: Outage Assessment

Der Einstieg ist das externe ComPython-Skript `powerfactory/start_assessment.py`, das einzige Skript,
das in PowerFactory ausgeführt wird. Es startet bzw. nutzt den Dashboard-Server, berechnet die
Szenarien nacheinander und speichert jedes sofort in die Ergebnisdatenbank, die das Dashboard (auch
von anderen PCs im Netz) live anzeigt. `SCENARIOS=None` bedeutet ein Szenario pro auswertbarem
Planned Outage unter seinem vorhandenen Namen; eine Liste mit `name` und `outages` definiert eigene
Kombinationen. Alle Referenzen und Namen werden vor dem ersten Rechenlauf geprüft. Datenbank,
Adresse und Port: `outage-assessment.config.json`; Betrieb: [DEPLOYMENT.md](DEPLOYMENT.md).

Start, Ende, Schrittweite, Profile und Ergebnisvariablen stammen aus dem aktiven `ComStatsim`.

## Anwendung der Ausfälle

Wie GridLens wird `ComStatsim.iopt_maint=0` für REF und `1` für OUTAGE verwendet.
PowerFactory berücksichtigt die eigenen `starttime`-/`endtime`-Fenster der
`IntPlannedout`-Objekte. Ausgewählte Ausfälle erhalten vorübergehend `outserv=0`,
übrige `outserv=1`. Auch vorher ignorierte Einträge können explizit Teil eines
Szenarios sein. Es gibt keine erfundenen Apply-/Reset-Aufrufe.

Outage-Flags, `iopt_maint`, `SetTime.cDate`/`cTime` und die originale
`ComStatsim.results`-Bindung werden erfasst, wiederhergestellt und verifiziert.
Die Rechnung verwendet kopierte ElmRes-Objekte mit der vorhandenen Variablenauswahl.
Erst nach ihrer Entfernung werden Szenarioname und beide vollständigen Ergebnisläufe
in einer SQLite-Transaktion gespeichert. Fehlerhafte Rechnungen bzw. nicht
verifizierte Wiederherstellung erzeugen kein gespeichertes neues Szenario.

`analysis_worker.py` enthält diese Verarbeitung und kann weiterhin einen einzelnen
bereits angelegten Auftrag bearbeiten. `start_assessment.py` legt solche Aufträge
selbst an; das Dashboard dient der Ergebnisvisualisierung und benötigt keine
manuelle Web-Auftragsanlage.

## Daten und reale Abnahme

Native Ergebnisse umfassen Auslastungen von Leitungen/Transformatoren und
Spannungen aus den konfigurierten QDS-Variablen. Der Datenbankexport speichert alle
Zeilen bis zur expliziten GridLens-Ergebnisgrenze, ohne Berichtsausdünnung auf 200
Punkte. REF und OUTAGE benötigen identische Zeitachsen. Unklare/out-of-period
Zeitachsen werden abgelehnt; keine Zeitverschiebung wird erfunden.

Die GridLens-Prüfung, ob ElmRes-Zeitstempel Intervallenden markieren, bleibt Teil
der nativen Windows-Abnahme. Ein echter PowerFactory-2026-Lauf wurde auf dem Mac
nicht ausgeführt. [Ablaufdiagramme und Fehlerpfade](../BIG_PICTURE.md).
