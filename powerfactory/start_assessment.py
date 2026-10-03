"""External ComPython script: calculate named outage scenarios, then open dashboard."""

from pathlib import Path
import sys

PROJECT_DIR = Path(__file__).resolve().parents[1]
# Configure these on the VM. Relative directories are resolved from PROJECT_DIR.
DATABASE_DIRECTORY = PROJECT_DIR / "backend/data"
DATABASE_NAME = "outage-assessment.sqlite3"
DASHBOARD_PYTHON = None  # default: backend/.venv/Scripts/python.exe
DASHBOARD_PORT = 0  # 0 chooses an unused local port
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
    database = directory / DATABASE_NAME
    validate_installation(python=DASHBOARD_PYTHON)
    try:
        names = run_assessment(app, database, SCENARIOS)
        dashboard = launch_dashboard(
            database,
            port=DASHBOARD_PORT,
            python=DASHBOARD_PYTHON,
            open_browser=OPEN_BROWSER,
        )
        app.PrintPlain(
            "[Outage Assessment] "
            + str(len(names))
            + " Szenarien gespeichert: "
            + str(database)
        )
        app.PrintPlain("[Outage Assessment] Dashboard: " + dashboard["url"])
        app.PrintPlain("[Outage Assessment] Server-PID: " + str(dashboard["pid"]))
    except BaseException as exc:
        app.PrintPlain("[Outage Assessment][ERROR] " + str(exc))
        raise


if __name__ == "__main__":
    main()
