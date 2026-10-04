"""External ComPython script: the one script to run in PowerFactory.

It calculates the reference once (every planned outage disabled), the LODF of the scenario equipment and
then one OUTAGE run per scenario, and saves each scenario in the results database. When
the calculation is finished it starts the dashboard server (or reuses the one that already runs) and
opens the dashboard in the browser. If a calculation fails after some scenarios were saved, the
dashboard is shown with those scenarios anyway. Later the results stay available: start the server
again with scripts/serve.py or set up the autostart (see docs/DEPLOYMENT.md).

Settings: constants below or outage-assessment.config.json in the project folder (database, host, port).
"""

from pathlib import Path
import importlib.util
import shutil
import sys
import time

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


def forget_cached_modules(modules, root=PROJECT_DIR):
    """Drop this project's modules from `modules` (sys.modules) so that they are read from disk again.

    PowerFactory keeps its Python interpreter between script runs. A module imported by an earlier run
    (possibly from an older copy of the files) would otherwise be used instead of the file next to this
    script, which fails with errors like "module has no attribute" after an update.
    """
    names = {"app"}
    for folder in ("powerfactory", "scripts"):
        names.update(path.stem for path in (Path(root) / folder).glob("*.py"))
    names -= {"__init__", Path(__file__).stem}
    for name in [n for n in modules if n in names or n.startswith("app.")]:
        del modules[name]


if importlib.util.find_spec("powerfactory") is not None:  # only inside PowerFactory, never in tests or tools
    forget_cached_modules(sys.modules)

import analysis_worker as worker
import appconfig
from pf_console import RULE, detail, log, step
from outage_plan import scenario_plan, split_by_period
from dashboard_launcher import launch_dashboard, validate_installation


STEPS = 5


def _span(period):
    return " to ".join(worker.engine._format_pf_time(value) for value in period)


def _minutes(seconds):
    return "{:d}:{:02d} min".format(int(seconds // 60), int(seconds % 60))


def _outage_line(outage):
    return "'{}': window {}, equipment: {}".format(
        outage["name"], _span((outage["start"], outage["end"])), outage.get("equipment_name") or "none found"
    )


def run_assessment(app, database_path, definitions=None):
    """REF once, LODF, then one OUTAGE run per scenario; each scenario is saved as soon as it is restored.

    Every scenario gets its own complete QDS over the simulated period with only its planned outages
    enabled: PowerFactory takes the equipment out of service inside the outage window and keeps it in
    service before and after. REF (every planned outage disabled) is the same for all scenarios, so it
    is calculated once and linked to each of them.

    Names and outages are checked before anything is calculated. Outage windows are compared with the
    period the reference actually covered, not only with the one ComStatsim declares: a scenario outside
    it is skipped with a warning instead of being saved without values.
    """
    started = time.monotonic()
    declared = worker.discover(app)
    plan = scenario_plan(declared, definitions)
    step(app, 1, STEPS, "Check the Study Case and the scenarios")
    detail(app, "Project: {} | Study Case: {} | ComStatsim: {}".format(
        declared["project"], declared["study_case"], declared["qds_command"]["name"]))
    detail(app, "Declared QDS period: " + _span(declared["period"]))
    detail(app, "{} planned outages found, {} scenarios to calculate:".format(len(declared["outages"]), len(plan)))
    by_id = {o["id"]: o for o in declared["outages"]}
    for number, selection in enumerate(plan, 1):
        detail(app, "{:>3}. {}".format(number, selection["name"]))
        for outage_id in selection["outage_ids"]:
            detail(app, "       " + _outage_line(by_id[outage_id]))

    step(app, 2, STEPS, "Reference (REF): one QDS with every planned outage disabled")
    reference = worker.calculate_reference(app, declared)
    period = worker.simulated_period(reference, declared["period"])
    detail(app, "REF done: {} time points from {}, {} series.".format(
        len(reference["labels"]), _span(period), sum(len(v) for v in reference["by_category"].values())))

    step(app, 3, STEPS, "Compare the outage windows with the simulated period")
    if any(d is None or abs(d - p) > 1 for d, p in zip(declared["period"], period)):
        detail(app, "ComStatsim declares " + _span(declared["period"]) + ", PowerFactory calculated "
               + _span(period) + ". Outage windows are compared with the calculated period; "
               "set the ComStatsim 'Time period' to cover the planned outages.", "WARN")
    catalog = worker.discover(app, period)
    plan, skipped = split_by_period(plan, catalog)
    for selection in plan:
        detail(app, "OK    '" + selection["name"] + "'")
    for selection, outside in skipped:
        detail(app, "SKIP  '" + selection["name"] + "': outside the simulated period " + _span(period) + ": "
               + "; ".join(_outage_line(o) if o.get("start") is not None else o["name"] for o in outside), "WARN")
    if not plan:
        raise RuntimeError(
            "No scenario lies in the simulated period " + _span(period) + " (" + str(len(skipped))
            + " skipped). Set the ComStatsim 'Time period' so that it covers the planned outages."
        )
    detail(app, "{} scenarios will be calculated, {} skipped.".format(len(plan), len(skipped)))

    # LODF depends only on topology: once, for the equipment of the scenarios that are calculated.
    step(app, 4, STEPS, "LODF: DC load flows with the equipment of each scenario switched off")
    rows = worker.compute_lodf(app, catalog, plan)
    if rows:
        store = worker.ScenarioStore(str(database_path))
        try:
            store.save_lodf(rows)
        finally:
            store.close()

    step(app, 5, STEPS, "Scenarios: one QDS per scenario with its planned outages enabled")
    for number, selection in enumerate(plan, 1):
        current = worker.discover(app, period)
        store = worker.ScenarioStore(str(database_path))
        try:
            store.publish_catalog(current)
            store.enqueue(
                "run",
                {**selection, "catalog_signature": worker.catalog_signature(current)},
            )
        finally:
            store.close()
        log(app, "Scenario {}/{}: {}".format(number, len(plan), selection["name"]))
        begun = time.monotonic()
        worker.execute(app, database_path, reference, period)
        detail(app, "Done in {:.1f} s.".format(time.monotonic() - begun))

    log(app, RULE)
    log(app, "Summary: {} scenarios saved, {} skipped, {} LODF values, total {}.".format(
        len(plan), len(skipped), len(rows), _minutes(time.monotonic() - started)))
    for selection, outside in skipped:
        detail(app, "skipped '" + selection["name"] + "' (outside the simulated period)", "WARN")
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
    if database.is_file():
        worker.ScenarioStore(str(database)).close()  # a file of an earlier version is refused here, not after REF
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
        log(app, RULE)
        log(app, "Outage assessment started")
        detail(app, f"Scripts: {Path(__file__).resolve().parent}")
        detail(app, f"Database: {database} ({free:.0f} GB free)")
        run_assessment(app, database, SCENARIOS)
    except KeyboardInterrupt:
        log(app, "Stopped by the user. Scenarios saved before stay in the database; "
            "the scenario that was running was not saved. PowerFactory settings were restored.", "ERROR")
        raise
    except BaseException as exc:
        log(app, str(exc) or type(exc).__name__, "ERROR")
        raise
    finally:
        show_saved_results(app, database, config)


if __name__ == "__main__":
    main()
