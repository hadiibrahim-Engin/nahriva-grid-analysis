"""External ComPython script: the one script to run in PowerFactory.

It calculates the outage scenarios one after another and saves each one in the results database. When
the calculation is finished it starts the dashboard server (or reuses the one that already runs) and
opens the dashboard in the browser. If a calculation fails after some scenarios were saved, the
dashboard is shown with those scenarios anyway. Later the results stay available: start the server
again with scripts/serve.py or set up the autostart (see docs/DEPLOYMENT.md).

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
DASHBOARD_HOST = "127.0.0.1"  # this PC only; "0.0.0.0" makes the dashboard reachable from other PCs (needs a firewall rule from IT)
DASHBOARD_PORT = 8765  # fixed, so the address can be bookmarked; 0 chooses a free port
SHOW_DASHBOARD = True  # start the dashboard after the calculation
OPEN_BROWSER = True  # ... and open it in the default browser

# None: one scenario per eligible Planned Outage, using its exact loc_name.
# Or supply named combinations. Use full PF object paths if names are ambiguous.
# SCENARIOS = [{'name': 'Outage North', 'outages': ['Maintenance Line North', 'Maintenance Transformer North']}]
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
        raise ValueError("No outage scenarios in the configured QDS period.")
    plan = []
    names = set()
    for definition in definitions:
        name = definition["name"].strip()
        if not name or len(name) > 200 or name in names:
            raise ValueError("Scenarios need unique names of 1–200 characters.")
        names.add(name)
        ids = []
        for reference in definition["outages"]:
            matches = [
                o for o in eligible if reference in (o["id"], o["path"], o["name"])
            ]
            if len(matches) != 1:
                raise ValueError(
                    "Outage is missing, outside the period or ambiguous: "
                    + reference
                )
            ids.append(matches[0]["id"])
        if not ids or len(ids) != len(set(ids)):
            raise ValueError(
                "A scenario needs a unique selection of outages: " + name
            )
        plan.append({"name": name, "outage_ids": ids})
    return plan


def run_assessment(app, database_path, definitions=None):
    """Validate all selections first; persist each successfully restored REF/OUTAGE pair."""
    catalog = worker.discover(app)
    plan = scenario_plan(catalog, definitions)
    # LODF depends only on topology: calculate it once, before any simulation.
    app.PrintPlain("[Outage Assessment] Calculating LODF")
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
        app.PrintPlain("[Outage Assessment] Calculating: " + selection["name"])
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
        raise RuntimeError("The database folder is not writable: " + str(database.parent) + " (" + str(exc) + ")") from None
    free_gb = shutil.disk_usage(database.parent).free / 1e9
    if free_gb < 2:
        raise RuntimeError(f"Not enough free space in the database folder: {free_gb:.1f} GB.")
    return free_gb


def has_results(database):
    store = worker.ScenarioStore(str(database))
    try:
        return bool(store.overview()["scenarios"])
    finally:
        store.close()


def show_dashboard(app, database, config):
    """Start (or reuse) the dashboard server and open it; a problem here is reported, not raised."""
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
        app.PrintPlain("[Outage Assessment][WARN] Dashboard not started: " + str(exc))
        return None
    app.PrintPlain("[Outage Assessment] Dashboard " + ("already running" if dashboard["reused"] else "started") + ": " + dashboard["url"])
    for url in dashboard["lan_urls"]:
        app.PrintPlain("[Outage Assessment] From other PCs in the network: " + url)
    for note in dashboard["notes"]:
        app.PrintPlain("[Outage Assessment][NOTE] " + note)
    return dashboard


def main():
    import powerfactory

    app = powerfactory.GetApplication()
    if app is None:
        raise RuntimeError(
            "Run this script in PowerFactory as an external ComPython script."
        )
    directory = Path(DATABASE_DIRECTORY).expanduser()
    if not directory.is_absolute():
        directory = PROJECT_DIR / directory
    if not DATABASE_NAME or Path(DATABASE_NAME).name != DATABASE_NAME:
        raise ValueError(
            "DATABASE_NAME must be a file name; set the folder with DATABASE_DIRECTORY."
        )
    config = appconfig.load(
        PROJECT_DIR, database=directory / DATABASE_NAME, host=DASHBOARD_HOST, port=DASHBOARD_PORT
    )
    database = config["database"]
    try:
        validate_installation(python=DASHBOARD_PYTHON)
        free = preflight(database)
        app.PrintPlain(f"[Outage Assessment] Database: {database} ({free:.0f} GB free)")
        names = run_assessment(app, database, SCENARIOS)
        app.PrintPlain("[Outage Assessment] " + str(len(names)) + " scenarios saved.")
    except BaseException as exc:
        app.PrintPlain("[Outage Assessment][ERROR] " + str(exc))
        raise
    finally:
        if SHOW_DASHBOARD and database.is_file() and has_results(database):
            show_dashboard(app, database, config)


if __name__ == "__main__":
    main()
