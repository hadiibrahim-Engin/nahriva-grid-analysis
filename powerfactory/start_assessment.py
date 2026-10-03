"""External ComPython script: the one script to run in PowerFactory.

It starts the dashboard server (or reuses the one that already runs), then calculates the outage
scenarios one after another and saves them in the results database next to it. The dashboard shows
every scenario as soon as it is saved, also on other PCs in the network (open the printed address in
a browser). Later, the saved results stay available: the server keeps serving the database, with or
without PowerFactory (see docs/DEPLOYMENT.md for the permanent Autostart).

Settings: constants below or outage-assessment.config.json in the project folder (database, host, port).
"""

from pathlib import Path
import shutil
import sys

PROJECT_DIR = Path(__file__).resolve().parents[1]
# Configure these on the VM. Relative directories are resolved from PROJECT_DIR.
DATABASE_DIRECTORY = PROJECT_DIR / "backend/data"
DATABASE_NAME = "outage-assessment.sqlite3"
DASHBOARD_PYTHON = None  # default: backend/.venv/Scripts/python.exe
DASHBOARD_HOST = "0.0.0.0"  # reachable from other PCs; "127.0.0.1" = only this PC
DASHBOARD_PORT = 8765  # fixed, so the address can be bookmarked; 0 chooses a free port
OPEN_BROWSER = True

# None: one scenario per eligible Planned Outage, using its exact loc_name.
# Or supply named combinations. Use full PF object paths if names are ambiguous.
# SCENARIOS = [{'name': 'Freischaltung Nord', 'outages': ['Wartung Leitung Nord', 'Wartung Trafo Nord']}]
SCENARIOS = None
# Simulation duration / steps / profiles are configured in the active ComStatsim.
# This script uses that full period without a dashboard date filter.

sys.path.insert(0, str(PROJECT_DIR / "powerfactory"))
sys.path.insert(0, str(PROJECT_DIR / "scripts"))
import analysis_worker as worker
import appconfig
from dashboard_launcher import launch_dashboard, validate_installation


def scenario_plan(catalog, definitions=None):
    eligible = [o for o in catalog["outages"] if o["in_period"]]
    if definitions is None:
        definitions = [{"name": o["name"], "outages": [o["path"]]} for o in eligible]
    if not definitions:
        raise ValueError("Keine Freischaltszenarien im konfigurierten QDS-Zeitraum.")
    plan = []
    names = set()
    for definition in definitions:
        name = definition["name"].strip()
        if not name or len(name) > 200 or name in names:
            raise ValueError("Szenarien benötigen eindeutige Namen mit 1–200 Zeichen.")
        names.add(name)
        ids = []
        for reference in definition["outages"]:
            matches = [
                o for o in eligible if reference in (o["id"], o["path"], o["name"])
            ]
            if len(matches) != 1:
                raise ValueError(
                    "Ausfall fehlt, liegt außerhalb des Zeitraums oder ist mehrdeutig: "
                    + reference
                )
            ids.append(matches[0]["id"])
        if not ids or len(ids) != len(set(ids)):
            raise ValueError(
                "Szenario benötigt eine eindeutige Ausfallauswahl: " + name
            )
        plan.append({"name": name, "outage_ids": ids})
    return plan


def run_assessment(app, database_path, definitions=None):
    """Validate all selections first; persist each successfully restored REF/OUTAGE pair."""
    catalog = worker.discover(app)
    plan = scenario_plan(catalog, definitions)
    # LODF depends only on topology: calculate it once, before any simulation.
    app.PrintPlain("[Outage Assessment] Berechne LODF")
    rows = worker.compute_lodf(app, catalog, plan)
    if rows:
        store = worker.ScenarioStore(str(database_path))
        try:
            store.save_lodf(rows)
        finally:
            store.close()
    for selection in plan:
        current = worker.discover(app)
        store = worker.ScenarioStore(str(database_path))
        try:
            store.publish_catalog(current)
            store.enqueue(
                "run",
                {**selection, "catalog_signature": worker.catalog_signature(current)},
            )
        finally:
            store.close()
        app.PrintPlain("[Outage Assessment] Berechne: " + selection["name"])
        worker.execute(app, database_path)
    return [s["name"] for s in plan]


def preflight(database):
    """Fail early, in plain words, before an hours-long calculation starts."""
    database.parent.mkdir(parents=True, exist_ok=True)
    probe = database.parent / ".write-test"
    try:
        probe.write_text("ok")
        probe.unlink()
    except OSError as exc:
        raise RuntimeError("Der Datenbankordner ist nicht beschreibbar: " + str(database.parent) + " (" + str(exc) + ")") from None
    free_gb = shutil.disk_usage(database.parent).free / 1e9
    if free_gb < 2:
        raise RuntimeError(f"Zu wenig freier Speicher im Datenbankordner: {free_gb:.1f} GB.")
    return free_gb


def start_dashboard(app, database, config):
    """Start (or reuse) the dashboard server; a problem here must not waste the calculation."""
    try:
        dashboard = launch_dashboard(
            database,
            host=config["host"],
            port=config["port"],
            python=DASHBOARD_PYTHON,
            open_browser=OPEN_BROWSER,
            reuse=True,
            production=config["production"],
        )
    except Exception as exc:
        app.PrintPlain("[Outage Assessment][WARN] Dashboard nicht gestartet: " + str(exc))
        return None
    app.PrintPlain("[Outage Assessment] Dashboard " + ("läuft bereits" if dashboard["reused"] else "gestartet") + ": " + dashboard["url"])
    for url in dashboard["lan_urls"]:
        app.PrintPlain("[Outage Assessment] Von anderen PCs im Netz: " + url)
    for note in dashboard["notes"]:
        app.PrintPlain("[Outage Assessment][HINWEIS] " + note)
    return dashboard


def main():
    import powerfactory

    app = powerfactory.GetApplication()
    if app is None:
        raise RuntimeError(
            "Dieses Skript in PowerFactory als externes ComPython ausführen."
        )
    directory = Path(DATABASE_DIRECTORY).expanduser()
    if not directory.is_absolute():
        directory = PROJECT_DIR / directory
    if not DATABASE_NAME or Path(DATABASE_NAME).name != DATABASE_NAME:
        raise ValueError(
            "DATABASE_NAME muss ein Dateiname sein; den Ordner über DATABASE_DIRECTORY angeben."
        )
    config = appconfig.load(
        PROJECT_DIR, database=directory / DATABASE_NAME, host=DASHBOARD_HOST, port=DASHBOARD_PORT
    )
    database = config["database"]
    try:
        validate_installation(python=DASHBOARD_PYTHON)
        free = preflight(database)
        worker.ScenarioStore(str(database)).close()  # the dashboard needs the file before the first result
        app.PrintPlain(f"[Outage Assessment] Datenbank: {database} ({free:.0f} GB frei)")
        start_dashboard(app, database, config)
        names = run_assessment(app, database, SCENARIOS)
        app.PrintPlain("[Outage Assessment] " + str(len(names)) + " Szenarien gespeichert. Das Dashboard zeigt sie bereits.")
    except BaseException as exc:
        app.PrintPlain("[Outage Assessment][ERROR] " + str(exc))
        raise


if __name__ == "__main__":
    main()
