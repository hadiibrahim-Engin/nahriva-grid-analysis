# Freischaltbewertung und Auswertung über alle Szenarien

Alles hier arbeitet **nur lesend** auf der SQLite-Datei. Berechnung und Speicherung der
Ergebnisse bleiben unverändert; neu ist allein die LODF-Tabelle `pf_lodf`.

## Lesereihenfolge

Die Navigation und die Seite folgen dem Weg einer Bewertung:

| Abschnitt | Frage |
|---|---|
| Kennzahlen | Wie viele Szenarien sind zulässig, bedingt, nicht zulässig? Wo liegen die Extremwerte? |
| Bewertung | Urteil je Szenario mit Begründung, Freischaltung, Zeitachse, Verteilung |
| Verlauf, Szenariodetails | Wann und wie lange ist das gewählte Szenario kritisch? |
| Spannung | Welche Sammelschiene verlässt das Band? |
| Matrix | Welches Betriebsmittel ist in welchem Szenario wie belastet? |
| Grafiken, Radar | Vergleich über alle Szenarien (Auslastung, Dauer, Änderung, LODF) |
| Detailtabelle | Jede Zahl, sortierbar |

Schwere Abschnitte laden erst, wenn sie nahe ins Bild kommen (siehe „Große Datenbanken“).
Erklärende Texte sind aus; sie lassen sich je Karte über **i** oder für alles über
**Erläuterungen** einblenden.

## Diagramme selbst hinzufügen

Die Vergleichsgrafiken gibt es auch als Vorlagen unter **Diagramm hinzufügen → Szenarioauswertung**:
Höchste Auslastung, Überlastdauer, Änderung der Auslastung, LODF und Änderung, sowie für Spannungen
**Spannung je Sammelschiene** und **Spannungsänderung (ΔU)**. Sie brauchen keine ausgewählten Zeitreihen.

- **Auswahl:** *Automatisch* zeigt die auffälligsten N (5 bis 30). *Ausgewählte* zeigt genau die
  gewählten Betriebsmittel (bzw. Sammelschienen) aus einer durchsuchbaren Liste, je Betriebsmittel eine Gruppe
  mit einem Balken pro Szenario. Zusätzlich lassen sich die **Szenarien** eingrenzen (Codes S01, S02 … bleiben
  die der Gesamtliste). Der Typ (alle, Leitungen, Transformatoren) filtert Leitungs- und Trafo-Diagramme.
- **Spannung:** Balken gehen von der Nennspannung 1,000 p.u. aus nach links und rechts, das Band 0,90 und 1,10
  ist eingezeichnet; ΔU ist die Änderung gegenüber REF an der Seite, die dem Band näher liegt.
- Die Karten teilen sich die Daten mit der Zusammenfassung, laden also nichts doppelt, folgen neuen
  Szenarien von selbst und bleiben mit der Ansicht gespeichert. Auswahl und Optionen lassen sich auf der Karte
  unter „Auswahl“ ändern.
- **Ausgeblendete Vorlagen:** Was mit PowerFactory-Daten (nur Auslastung und Spannung, kurze Simulation) nicht
  funktioniert, wird im Dialog nicht angeboten, bleibt aber registriert, damit gespeicherte Karten weiterlaufen.
  Liste mit Begründung: `HIDDEN_TEMPLATE_REASONS` in `frontend/src/components/charts/chartTemplates.ts`;
  Eintrag löschen, um eine Vorlage wieder anzubieten. Neue Vorlagen ebenfalls dort.

## Definitionen

- **Szenariowert:** maximale OUTAGE-Auslastung im Ausfallfenster des Szenarios.
- **Base:** maximale REF-Auslastung über den gesamten Zeitraum.
- **Δ Loading:** Szenariowert minus REF im selben Fenster, in Prozentpunkten (pp).
- **Overload Rate:** Zeit über 100 % im ungünstigsten Szenario, bezogen auf den
  **Simulationszeitraum** (nicht auf die Zahl der Szenarien).
- **Excess:** `max(Loading − 100 %, 0)` in pp; Summe, Maximum und Mittel stehen in der Tabelle.
- **Verursachung** gegenüber REF im selben Fenster: *verursacht* (REF ≤ 100 %, mit Freischaltung
  darüber), *verschärft* (schon darüber, mindestens 2 pp höher), *Vorbelastung* (unverändert).
- Ein im Szenario freigeschaltetes Betriebsmittel wird dort nicht bewertet („AUS“).

## Freigabe-Bewertung

Bewertet werden alle Betriebsmittel: Leitungen und Transformatoren nach Auslastung,
Sammelschienen nach Spannung.

| Urteil | Kriterium |
|---|---|
| Nicht zulässig | Überlastung oder Spannungsverletzung durch die Freischaltung verursacht oder verschärft |
| Bedingt zulässig | keine neue Verletzung, aber Vorbelastung > 100 %, Reserve < 5 pp, Warnbereich ≥ 80 % neu erreicht oder Spannung näher als 0,02 p.u. an der Grenze |
| Zulässig | sonst, mit höchster Auslastung und Reserve |

Das Urteil ist eine Entscheidungshilfe nach diesen Kriterien, keine Freigabe. Der Typfilter
(Alle / Leitungen / Transformatoren) schränkt nur Matrix, Grafiken, Radar und Tabelle ein.

**Spannung:** Das Band ist zentral **0,90 bis 1,10 p.u.** und gilt für alle in p.u. gespeicherten
Ergebnisse. Ergebnisse in kV werden gegen die mit ihnen gespeicherten Grenzen beurteilt; ohne
Grenzen wird keine Verletzung abgeleitet.

## LODF

`powerfactory/lodf.py` rechnet **vor der ersten Simulation** DC-Lastflüsse (`ComLdf`,
`iopt_net=2`): je Szenario werden dessen Ausfallobjekte gemeinsam abgeschaltet und
`LODF = ΔP_Betriebsmittel / ΣP_ausgefallen,vorher` bestimmt (bei mehreren Ausfällen mit Beträgen
normiert; angezeigt wird |LODF|). Die Werte stehen in `pf_lodf`, getrennt von den Ergebnisläufen.
Schlägt der Lastfluss fehl, gibt es eine Warnung, die Szenarien laufen trotzdem, und das
Dashboard zeigt „nicht berechnet“. Auf der VM zu prüfen: Variablen `m:P:bus1` / `m:P:bushv` und
die Zuordnung der Ausfallobjekte zu Betriebsmitteln.

## Große Datenbanken

Der Server liest nur, was gefragt wird, und das Frontend fragt nur, was sichtbar wird.

1. `GET /across-scenarios/index` liefert Szenarien und Freischaltungen **ohne Samples zu lesen**.
2. Danach holt das Frontend `GET /across-scenarios/{id}/cells` Szenario für Szenario
   (3 gleichzeitig). Die Szenarien erscheinen in fester Reihenfolge, die Codes S01, S02 … bleiben
   stabil, die ersten Urteile stehen vor dem Ende. Ein Fortschrittsbalken zeigt den Stand.
3. Je Szenario genügen zwei gruppierte SQL-Durchläufe über die Lastreihen (REF und OUTAGE) plus
   wenige für die Spannung. Das Ergebnis wird im Server zwischengespeichert; gespeicherte Szenarien
   ändern sich nie, ein Auffrischen lädt daher nur neue Szenarien nach.
4. Abschnitte unterhalb der Bewertung (Verlauf, Details, Spannung, Matrix, Grafiken, Radar,
   Tabelle) hängen sich erst ein, wenn sie nahe ins Bild kommen oder die Navigation sie anspringt.
   Erst dann werden ihr Code und ihre Daten geladen. `GET .../{id}/profile` reduziert eine
   Zeitreihe auf höchstens 300 Punkte (Maximum je Bucket, Spitzen bleiben erhalten).
5. Matrix und Tabelle zeigen zunächst die auffälligsten Betriebsmittel und blättern weiter.

Nicht gemessen: das Verhalten bei Millionen Zeilen je Lauf auf der echten VM. Die Aufteilung ist
dafür vorbereitet; Zeiten bitte dort prüfen.

## API (lesend)

| Pfad | Inhalt |
|---|---|
| `GET /api/simulation/across-scenarios/index` | Szenarien, Freischaltungen, Zeitraum |
| `GET /api/simulation/across-scenarios/{id}/cells` | reduzierte Werte eines Szenarios (zwischengespeichert) |
| `GET /api/simulation/across-scenarios/{id}/profile` | Belastungsverlauf der kritischsten Betriebsmittel |
| `GET /api/simulation/across-scenarios` | alles zusammen (Index plus alle Szenarien) |

## Wo anpassen

| Was | Datei |
|---|---|
| Auslastungsbänder, Schwellen für Muster, Gewichte der Auffälligkeit | `frontend/src/config/loadingBands.ts` |
| Kriterien der Bewertung, Spannungsband, Reserve | `frontend/src/config/assessment.ts` |
| Logik der Bewertung | `frontend/src/util/freischaltung.ts` |
| Laden in Teilen | `frontend/src/hooks/useAcrossData.ts`, `frontend/src/util/acrossLoad.ts` |
| Aggregation, Cache | `backend/app/simulation/across.py` |
