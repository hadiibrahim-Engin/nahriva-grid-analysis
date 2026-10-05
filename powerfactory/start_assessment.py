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
from pf_console import detail, log, section, step, subsection, table
from outage_plan import scenario_plan, split_by_period
from dashboard_launcher import launch_dashboard


STEPS = 5
INTERFACE_VERSION = 3  # every module must report the same; see check_installation


def check_installation():
    """Stop with a clear message when the files of this installation are of different versions.

    PowerFactory runs whatever files it finds. After an update by copying single files, a new script can meet an
    old module and fail with errors like "too many values to unpack" or "has no attribute". Every module that
    the others depend on states its INTERFACE_VERSION; this compares them with the one of this script.
    """
    import importlib

    names = ["analysis_worker", "lodf", "pf_console", "pf_state", "outage_plan", "run_summary",
             "app.simulation.store", "app.analysis.schema", "app.analysis.series"]
    wrong = []
    for name in names:
        module = importlib.import_module(name)
        version = getattr(module, "INTERFACE_VERSION", None)
        if version != INTERFACE_VERSION:
            wrong.append("    {:<24} version {}  ({})".format(
                name, "unknown (older)" if version is None else version, getattr(module, "__file__", "?")))
    if wrong:
        raise RuntimeError(
            "The files of this installation are from different versions (this script is version {}):\n{}\n"
            "Replace the complete folders powerfactory\\ and backend\\app\\ with the ones of the same release "
            "(for example with git pull); single files cannot be mixed.".format(INTERFACE_VERSION, "\n".join(wrong))
        )


def _span(period):
    return " to ".join(worker.engine._format_pf_time(value) for value in period)


def _minutes(seconds):
    return "{:d}:{:02d} min".format(int(seconds // 60), int(seconds % 60))


def _outage_line(outage):
    return "'{}': window {}, equipment: {}".format(
        outage["name"], _span((outage["start"], outage["end"])), outage.get("equipment_name") or "none found"
    )


def report(database, state, step_title, detail_text="", current=None, total=None, restart=False):
    """Tell the dashboard where the run is (the banner "PowerFactory is working ...").

    Never raises: a progress note must not be able to stop a calculation that may have run for hours.
    """
    try:
        store = worker.ScenarioStore(str(database))
        try:
            store.set_progress(state, step_title, detail_text, current, total, restart)
        finally:
            store.close()
    except Exception:
        pass


def _window(outage):
    return _span((outage["start"], outage["end"])) if outage.get("start") is not None else "unreadable"


def run_assessment(app, database_path, definitions=None):
    """REF once, LODF, then one OUTAGE run per scenario; each scenario is saved as soon as it is restored.

    Every scenario gets its own complete QDS over the simulated period with only its planned outages
    enabled: PowerFactory takes the equipment out of service inside the outage window and keeps it in
    service before and after. REF (every planned outage disabled) is the same for all scenarios, so it
    is calculated once and linked to each of them.

    Names and outages are checked before anything is calculated. Outage windows are compared with the
    period the reference actually covered, not only with the one ComStatsim declares: a scenario outside
    it is skipped with a warning instead of being saved without values.

    The output has one section per step and one subsection per scenario and case; the summary at the end
    repeats the result of every scenario in one table.
    """
    started = time.monotonic()

    def begin(number, title):
        step(app, number, STEPS, title)
        report(database_path, "running", "STEP {}/{} · {}".format(number, STEPS, title), restart=number == 1)

    declared = worker.discover(app)
    plan = scenario_plan(declared, definitions)

    begin(1, "Check the Study Case and the scenarios")
    detail(app, "Project: {} | Study Case: {} | ComStatsim: {}".format(
        declared["project"], declared["study_case"], declared["qds_command"]["name"]))
    detail(app, "Declared QDS period: " + _span(declared["period"]))
    detail(app, "Planned outages in the project ({}):".format(len(declared["outages"])))
    table(app, ("Planned outage", "Equipment", "Window", "In period", "Disabled in Study Case"),
          [(o["name"], o["equipment_name"] or "none found", _window(o), "yes" if o["in_period"] else "no",
            "yes" if o["ignored"] else "no") for o in declared["outages"]])
    by_id = {o["id"]: o for o in declared["outages"]}
    detail(app, "Scenarios to calculate ({}):".format(len(plan)))
    table(app, ("#", "Scenario", "Planned outages"),
          [(number, selection["name"], "; ".join(by_id[i]["name"] for i in selection["outage_ids"]))
           for number, selection in enumerate(plan, 1)])

    begin(2, "Reference (REF): one QDS with every planned outage disabled")
    reference = worker.calculate_reference(app, declared)
    period = worker.simulated_period(reference, declared["period"])
    detail(app, "REF done: {} time points from {}, {} series.".format(
        len(reference["labels"]), _span(period), sum(len(v) for v in reference["by_category"].values())))

    begin(3, "Compare the outage windows with the simulated period")
    detail(app, "Declared by ComStatsim: " + _span(declared["period"]))
    detail(app, "Calculated by PowerFactory: " + _span(period))
    if any(d is None or abs(d - p) > 1 for d, p in zip(declared["period"], period)):
        detail(app, "The two differ. Outage windows are compared with the calculated period; "
               "set the ComStatsim 'Time period' to cover the planned outages.", "WARN")
    catalog = worker.discover(app, period)
    plan, skipped = split_by_period(plan, catalog)
    table(app, ("Result", "Scenario", "Reason"),
          [("OK", s["name"], "all outages lie in the calculated period") for s in plan]
          + [("SKIP", s["name"], "outside the calculated period: "
              + "; ".join(_outage_line(o) if o.get("start") is not None else o["name"] for o in outside))
             for s, outside in skipped],
          level="")
    if not plan:
        raise RuntimeError(
            "No scenario lies in the simulated period " + _span(period) + " (" + str(len(skipped))
            + " skipped). Set the ComStatsim 'Time period' so that it covers the planned outages."
        )
    detail(app, "{} scenarios will be calculated, {} skipped.".format(len(plan), len(skipped)))

    # LODF depends only on topology: once, for the equipment of the scenarios that are calculated.
    begin(4, "LODF: PowerFactory's Sensitivities / Distribution Factors for the equipment of each scenario")
    rows, undefined = worker.compute_lodf(app, catalog, plan)
    if rows or undefined:
        store = worker.ScenarioStore(str(database_path))
        try:
            store.save_lodf(rows, undefined)
        finally:
            store.close()
    lines_per_outage = {}
    for row in rows:
        lines_per_outage[row[0]] = lines_per_outage.get(row[0], 0) + 1

    def lodf_status(selection):
        key = worker.outage_key(selection["outage_ids"])
        if key in undefined:  # the reason starts with "LODF '<scenario>': ", the table row already names the scenario
            reason = undefined[key]
            return "none: " + (reason.split("': ", 1)[1] if reason.startswith("LODF '") and "': " in reason else reason)
        return "{} lines".format(lines_per_outage[key]) if key in lines_per_outage else "not calculated"

    detail(app, "LODF per scenario:")
    table(app, ("#", "Scenario", "LODF"),
          [(number, selection["name"], lodf_status(selection)) for number, selection in enumerate(plan, 1)])

    begin(5, "Scenarios: one QDS per scenario with its planned outages enabled")
    saved = []
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
        subsection(app, "Scenario {}/{} · {}".format(number, len(plan), selection["name"]))
        report(database_path, "running", "STEP 5/5 · Scenarios", "Scenario {}/{} · {}".format(number, len(plan), selection["name"]),
               number, len(plan))
        begun = time.monotonic()
        outcome = worker.execute(app, database_path, reference, period) or {}
        seconds = time.monotonic() - begun
        detail(app, "Done in {:.1f} s.".format(seconds))
        saved.append((number, selection["name"], seconds, lodf_status(selection), outcome.get("summary") or ""))

    section(app, "SUMMARY")
    detail(app, "{} scenarios saved, {} skipped, {} LODF values, total {}.".format(
        len(plan), len(skipped), len(rows), _minutes(time.monotonic() - started)))
    table(app, ("#", "Scenario", "Time", "LODF", "Result in the outage window"),
          [(number, name, "{:.0f} s".format(seconds), lodf, result.replace("in the outage window: ", ""))
           for number, name, seconds, lodf, result in saved])
    for selection, outside in skipped:
        detail(app, "skipped '" + selection["name"] + "' (outside the simulated period)", "WARN")
    report(database_path, "finished", "Finished", "{} scenarios saved, {} skipped, total {}".format(
        len(plan), len(skipped), _minutes(time.monotonic() - started)), len(plan), len(plan))
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
    # Created now, not after the reference run: the dashboard can open it from the start, and a file of an
    # earlier version is refused here, not after hours of calculation.
    worker.ScenarioStore(str(database)).close()
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
        detail(app, "Dashboard not started: " + str(exc), "WARN")
        return None
    detail(app, "Dashboard " + ("already running" if dashboard["reused"] else "started") + ": " + dashboard["url"])
    for url in dashboard["lan_urls"]:
        detail(app, "From other PCs in the network: " + url)
    for note in dashboard["notes"]:
        detail(app, note, "NOTE")
    return dashboard


def start_dashboard(app, database, config):
    """Start (or reuse) the dashboard before the calculation, so that every scenario can be looked at as soon as
    it is saved. Returns the dashboard, or None when it is switched off or could not be started."""
    if not SHOW_DASHBOARD:
        return None
    section(app, "DASHBOARD")
    detail(app, "Started before the calculation: scenarios appear in it as soon as PowerFactory has saved them "
                "(it refreshes itself every few seconds).")
    return show_dashboard(app, database, config)


def show_saved_results(app, database, config, dashboard=None):
    """At the end: say where the dashboard is, also after a failure; start it when it could not be started before.

    Never raises: the error that ended the run must stay visible.
    """
    if not SHOW_DASHBOARD:
        return
    try:
        if dashboard is not None:
            section(app, "DASHBOARD")
            detail(app, "Running: " + dashboard["url"])
        elif database.is_file() and has_results(database):
            section(app, "DASHBOARD")
            show_dashboard(app, database, config)
    except Exception as exc:
        detail(app, "Dashboard not started: " + str(exc), "WARN")


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
    dashboard = None
    try:
        check_installation()
        free = preflight(database)  # the dashboard is checked when it starts: without it the calculation still runs
        section(app, "OUTAGE ASSESSMENT · started " + time.strftime("%Y-%m-%d %H:%M:%S"))
        detail(app, f"Scripts:  {Path(__file__).resolve().parent}")
        detail(app, f"Database: {database} ({free:.0f} GB free)")
        detail(app, "Dashboard: {}:{}{}".format(config["host"], config["port"], "" if SHOW_DASHBOARD else " (not started)"))
        dashboard = start_dashboard(app, database, config)
        run_assessment(app, database, SCENARIOS)
    except KeyboardInterrupt:
        report(database, "stopped", "Stopped by the user", "Scenarios saved before stay in the database.")
        section(app, "STOPPED BY THE USER")
        detail(app, "Scenarios saved before stay in the database; the scenario that was running was not saved.", "ERROR")
        detail(app, "PowerFactory settings were restored.", "ERROR")
        raise
    except BaseException as exc:
        report(database, "failed", "Stopped by an error", (str(exc) or type(exc).__name__).splitlines()[0][:300])
        section(app, "ERROR")
        for line in (str(exc) or type(exc).__name__).splitlines():
            detail(app, line, "ERROR")
        raise
    finally:
        show_saved_results(app, database, config, dashboard)


if __name__ == "__main__":
    main()
