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
from pf_console import log
from outage_plan import scenario_plan
from dashboard_launcher import launch_dashboard, validate_installation


def run_assessment(app, database_path, definitions=None):
    """Validate all selections first; persist each successfully restored REF/OUTAGE pair."""
    catalog = worker.discover(app)
    plan = scenario_plan(catalog, definitions)
    # LODF depends only on topology: calculate it once, before any simulation.
    log(app, "Calculating LODF")
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
        log(app, "Calculating: " + selection["name"])
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
        log(app, "Dashboard not started: " + str(exc), "WARN")
        return None
    log(app, "Dashboard " + ("already running" if dashboard["reused"] else "started") + ": " + dashboard["url"])
    for url in dashboard["lan_urls"]:
        log(app, "From other PCs in the network: " + url)
    for note in dashboard["notes"]:
        log(app, note, "NOTE")
    return dashboard


def show_saved_results(app, database, config):
    """Show whatever was saved, also after a failure. Never raises: the error that ended the run must stay visible."""
    if not SHOW_DASHBOARD:
        return
    try:
        if database.is_file() and has_results(database):
            show_dashboard(app, database, config)
    except Exception as exc:
        log(app, "Dashboard not started: " + str(exc), "WARN")


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
        log(app, f"Database: {database} ({free:.0f} GB free)")
        names = run_assessment(app, database, SCENARIOS)
        log(app, str(len(names)) + " scenarios saved.")
    except BaseException as exc:
        log(app, str(exc) or type(exc).__name__, "ERROR")
        raise
    finally:
        show_saved_results(app, database, config)


if __name__ == "__main__":
    main()
