"""Exercise PF state restoration and atomic persistence with a native-API fake."""

import importlib.util
import sqlite3
import sys
from types import SimpleNamespace
from pathlib import Path
import pytest
from app.simulation.store import ScenarioStore, catalog_signature

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "analysis_worker", ROOT / "powerfactory/analysis_worker.py"
)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class PFObject:
    def __init__(self, name, kind, **attrs):
        self.loc_name = name
        self.kind = kind
        self.__dict__.update(attrs)

    def GetClassName(self):
        return self.kind

    def GetFullName(self):
        return "Project/" + self.loc_name + "." + self.kind

    def GetContents(self, *args):
        return []


class Result(PFObject):
    def __init__(self, start, count=300):
        super().__init__("Result", "ElmRes")
        self.line = PFObject("Line A", "ElmLne", uknom=110)
        self.time = PFObject("Clock", "SetTime")
        self.times = [start + i * 900 for i in range(count)]
        self.values = [90] * count
        self.deleted = False

    def GetNumberOfRows(self):
        return len(self.times)

    def GetNumberOfColumns(self):
        return 2

    def GetVariable(self, column):
        return ("b:tnow", "c:loading")[column]

    def GetObject(self, column):
        return (self.time, self.line)[column]

    def GetUnit(self, column):
        return ("s", "%")[column]

    def GetColumnValues(self, column):
        return (self.times, self.values)[column]

    def Load(self):
        pass

    def Release(self):
        pass

    def Delete(self):
        self.deleted = True
        return 0


class App:
    def __init__(self, fail=False):
        self.start = 1769817600
        self.original = Result(self.start)
        self.project = PFObject("Project", "IntPrj")
        self.study = PFObject("Study", "IntCase")
        self.clock = PFObject("Clock", "SetTime", cDate=20260131, cTime=120000)
        self.outages = [
            PFObject(
                "Chosen",
                "IntPlannedout",
                starttime=self.start,
                endtime=self.original.times[-1],
                components=[self.original.line],
                outserv=1,
                priority=1,
            ),
            PFObject(
                "Other",
                "IntPlannedout",
                starttime=self.start,
                endtime=self.original.times[-1],
                components=[self.original.line],
                outserv=0,
                priority=1,
            ),
        ]
        self.qds = PFObject(
            "QDS",
            "ComStatsim",
            results=self.original,
            iopt_maint=1,
            startTime=self.start,
            endTime=self.original.times[-1],
        )
        self.calls = []
        self.copies = []
        self.fail = fail
        self.study.AddCopy = self.copy
        self.project.GetContents = self.contents
        self.qds.Execute = self.calculate

    def copy(self, result):
        clone = Result(self.start)
        self.copies.append(clone)
        return clone

    def contents(self, pattern, *args):
        return [o for o in self.outages if pattern.endswith(o.kind)]

    def calculate(self):
        selected = [o.loc_name for o in self.outages if o.outserv == 0]
        self.calls.append((self.qds.iopt_maint, selected))
        self.clock.cDate = 20260204
        self.qds.results.values = [110 if self.qds.iopt_maint else 90] * 300
        if self.fail and len(self.calls) == 2:
            raise RuntimeError("QDS failed")
        return 0

    def PrintPlain(self, message):
        pass

    def GetActiveProject(self):
        return self.project

    def GetActiveStudyCase(self):
        return self.study

    def GetProjectFolder(self, key):
        return None

    def GetCalcRelevantObjects(self, *args):
        return []

    def GetFromStudyCase(self, kind):
        return (
            self.qds
            if kind == "ComStatsim"
            else self.clock
            if kind == "SetTime"
            else None
        )


def queue(app, path, name="D7 · Maintenance North"):
    store = ScenarioStore(str(path))
    catalog = worker.discover(app)
    store.publish_catalog(catalog)
    job_id = store.enqueue(
        "run",
        {
            "name": name,
            "outage_ids": [worker.identifier(app.outages[0].GetFullName())],
            "catalog_signature": catalog_signature(catalog),
        },
    )
    store.close()
    return job_id


def restored(app):
    assert app.qds.iopt_maint == 1 and app.qds.results is app.original
    assert app.clock.cDate == 20260131 and app.clock.cTime == 120000
    assert [o.outserv for o in app.outages] == [1, 0]
    assert all(result.deleted for result in app.copies)


def test_named_outage_selection_and_full_results_are_persisted(tmp_path):
    path = tmp_path / "results.sqlite3"
    app = App()
    job_id = queue(app, path)
    worker.execute(app, path)
    restored(app)
    assert app.calls == [(0, []), (1, ["Chosen"])]  # REF: every planned outage disabled
    with sqlite3.connect(path) as db:
        assert (
            db.execute("SELECT name FROM pf_scenarios").fetchone()[0]
            == "D7 · Maintenance North"
        )
        assert db.execute("SELECT COUNT(*) FROM analysis_values").fetchone()[0] == 600
        assert (
            db.execute(
                "SELECT COUNT(DISTINCT t) FROM analysis_values"
            ).fetchone()[0]
            == 300
        )
        assert (
            db.execute("SELECT status FROM pf_jobs WHERE id=?", (job_id,)).fetchone()[0]
            == "completed"
        )
        assert (
            db.execute(
                "SELECT DISTINCT v.value FROM analysis_values v JOIN analysis_series se ON se.id=v.series_id "
                "WHERE se.run_id LIKE '%OUTAGE'"
            ).fetchone()[0]
            == 110
        )


def test_failed_calculation_restores_state_and_commits_no_scenario(tmp_path):
    path = tmp_path / "results.sqlite3"
    app = App(fail=True)
    queue(app, path)
    with pytest.raises(worker.engine.GridLensError, match="failed"):
        worker.execute(app, path)
    restored(app)
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT COUNT(*) FROM pf_scenarios").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM analysis_runs").fetchone()[0] == 0
        assert db.execute("SELECT status FROM pf_jobs").fetchone()[0] == "failed"


def test_result_provenance_is_captured_and_does_not_follow_live_catalog(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "powerfactory", SimpleNamespace(__version__="26.0.3"))
    app = App()
    operational = PFObject("Winter peak", "IntScenario")
    network = PFObject("Transmission model", "ElmNet")
    app.GetActiveScenario = lambda: operational
    app.GetCalcRelevantObjects = lambda pattern: [network] if pattern == "*.ElmNet" else []
    path = tmp_path / "provenance.sqlite3"
    queue(app, path)
    worker.execute(app, path)
    store = ScenarioStore(path)
    snapshot = store.overview()["scenarios"][0]["provenance"]
    assert snapshot["powerfactory_version"] == "26.0.3"
    assert snapshot["project_path"] == app.project.GetFullName()
    assert snapshot["study_case_path"] == app.study.GetFullName()
    assert snapshot["operational_scenario"]["name"] == "Winter peak"
    assert snapshot["networks"][0]["name"] == "Transmission model"
    assert snapshot["qds_command"]["path"] == app.qds.GetFullName()
    store.publish_catalog({**store.catalog(), "project": "Other model", "powerfactory_version": "27.0.1"})
    assert store.overview()["scenarios"][0]["provenance"] == snapshot
    assert store.overview()["scenarios"][0]["runs"][0]["source"] == "PowerFactory"
    store.close()


def test_missing_native_module_version_is_not_inferred(monkeypatch):
    monkeypatch.delitem(sys.modules, "powerfactory", raising=False)
    catalog = worker.discover(App())
    assert catalog["powerfactory_version"] is None
    assert catalog["project"] == "Project" and catalog["study_case"] == "Study"


def test_stale_study_period_rejected_before_calculation(tmp_path):
    path = tmp_path / "results.sqlite3"
    app = App()
    queue(app, path)
    app.qds.endTime += 3600
    with pytest.raises(RuntimeError, match="changed"):
        worker.execute(app, path)
    assert not app.calls
    restored(app)


def test_restore_error_prevents_result_publication(tmp_path, monkeypatch):
    path = tmp_path / "results.sqlite3"
    app = App()
    queue(app, path)
    monkeypatch.setattr(
        worker.engine,
        "_restore_planned_outage_option",
        lambda *args: ["Could not restore option"],
    )
    with pytest.raises(RuntimeError, match="restoration failed"):
        worker.execute(app, path)
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT COUNT(*) FROM analysis_runs").fetchone()[0] == 0


def test_failed_sql_write_rolls_back_both_runs_and_scenario(tmp_path):
    path = tmp_path / "results.sqlite3"
    app = App()
    queue(app, path)
    store = ScenarioStore(str(path))
    job = store.claim()
    catalog = worker.discover(app)
    bad = {
        "kind": "OUTAGE",
        "elements": [],
        "metrics": [],
        "samples": [("unknown", "loading", 1769817600, 1)],
    }
    with pytest.raises(sqlite3.IntegrityError):
        store.save_scenario(job, catalog, [bad])
    assert store.db.execute("SELECT COUNT(*) FROM pf_scenarios").fetchone()[0] == 0
    assert store.db.execute("SELECT COUNT(*) FROM analysis_runs").fetchone()[0] == 0
    store.close()


def test_live_job_is_not_reclaimed_or_marked_failed(tmp_path):
    path = tmp_path / "results.sqlite3"
    store = ScenarioStore(str(path))
    store.enqueue("sync", {})
    store.claim()
    with pytest.raises(RuntimeError, match="already running"):
        store.claim()
    assert store.overview()["jobs"][0]["status"] == "running"
    store.close()


def assessment_module():
    spec = importlib.util.spec_from_file_location(
        "start_assessment", ROOT / "powerfactory/start_assessment.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_batch_runs_each_named_planned_outage_and_restores_state(tmp_path):
    assessment = assessment_module()
    app = App()
    path = tmp_path / "batch.sqlite3"
    assert assessment.run_assessment(app, path) == ["Chosen", "Other"]
    restored(app)
    # One reference with every planned outage disabled, then one OUTAGE run per planned outage.
    assert app.calls == [(0, []), (1, ["Chosen"]), (1, ["Other"])]
    store = ScenarioStore(str(path))
    assert {s["name"] for s in store.overview()["scenarios"]} == {"Chosen", "Other"}
    # The reference is stored once and linked to both scenarios: 3 runs of 300 samples.
    assert store.db.execute("SELECT COUNT(*) FROM analysis_runs").fetchone()[0] == 3
    assert store.db.execute("SELECT COUNT(*) FROM analysis_values").fetchone()[0] == 900
    refs = {r[0] for r in store.db.execute("SELECT run_id FROM pf_scenario_runs WHERE kind='REF'")}
    assert len(refs) == 1
    assert store.db.execute("SELECT COUNT(*) FROM pf_scenario_runs").fetchone()[0] == 4
    store.close()


def test_batch_validates_all_combinations_before_native_calculation(tmp_path):
    assessment = assessment_module()
    app = App()
    definitions = [
        {"name": "Both", "outages": ["Chosen", "Other"]},
        {"name": "Invalid", "outages": ["Missing"]},
    ]
    with pytest.raises(ValueError, match="Missing"):
        assessment.run_assessment(app, tmp_path / "invalid.sqlite3", definitions)
    assert app.calls == []
    definitions.pop()
    assert assessment.run_assessment(
        app, tmp_path / "combined.sqlite3", definitions
    ) == ["Both"]
    assert app.calls == [(0, []), (1, ["Chosen", "Other"])]
    restored(app)


def test_outage_outside_the_simulated_period_is_skipped_not_saved_empty(tmp_path):
    """ComStatsim may declare a longer period than it simulates (e.g. 'Time period' = one month).

    Outage windows are compared with the time axis PowerFactory actually calculated."""
    assessment = assessment_module()
    app = App()
    messages = []
    app.PrintPlain = messages.append
    late = app.original.times[-1] + 30 * 86400  # one month after the last simulated point
    app.outages[1].starttime, app.outages[1].endtime = late, late + 86400
    app.qds.endTime = late + 86400  # declared: covers both outages; simulated: only the first
    path = tmp_path / "period.sqlite3"
    assert assessment.run_assessment(app, path) == ["Chosen"]
    assert app.calls == [(0, []), (1, ["Chosen"])]  # no OUTAGE run whose window cannot be in the results
    assert any("WARN" in m and "Other" in m and "outside the simulated period" in m for m in messages)
    assert any("declares" in m for m in messages)  # the period mismatch itself is reported
    store = ScenarioStore(str(path))
    assert [s["name"] for s in store.overview()["scenarios"]] == ["Chosen"]
    assert store.catalog()["period"] == [app.original.times[0], app.original.times[-1]]
    store.close()
    restored(app)


def test_no_scenario_in_the_simulated_period_stops_with_a_clear_message(tmp_path):
    assessment = assessment_module()
    app = App()
    late = app.original.times[-1] + 30 * 86400
    for outage in app.outages:
        outage.starttime, outage.endtime = late, late + 86400
    app.qds.endTime = late + 86400
    with pytest.raises(RuntimeError, match="Time period"):
        assessment.run_assessment(app, tmp_path / "none.sqlite3")
    assert app.calls == [(0, [])]  # only the reference was calculated
    restored(app)


def test_output_shows_each_step_and_the_result_of_each_scenario(tmp_path):
    assessment = assessment_module()
    app = App()
    messages = []
    app.PrintPlain = messages.append
    assessment.run_assessment(app, tmp_path / "output.sqlite3")
    text = "\n".join(messages)
    for number in range(1, 6):
        assert f"Step {number}/5" in text
    assert "Scenario 2/2: Other" in text
    # what the OUTAGE run does, in plain words
    assert "'Chosen' enabled, active" in text and "keeps it in service before and after" in text
    assert "highest loading 110.0 % (Line A), REF 90.0 %" in text
    assert "Summary: 2 scenarios saved, 0 skipped" in text
    # the planned outages a case disables on purpose are counted, not warned about one by one
    assert "Outage object is disabled" not in text


class Terminal(PFObject):
    def __init__(self, name):
        super().__init__(name, "ElmTerm", uknom=110, systype=0)


class ResultWithIsolatedNode(Result):
    """ElmRes with a time column, a line and two terminals; one terminal is cut off from the grid mid-run."""

    def __init__(self, start, count=6, nan_in="voltage"):
        super().__init__(start, count)
        self.nodes = [Terminal("T1"), Terminal("T2.1")]
        self.nan_in = nan_in

    def GetNumberOfColumns(self):
        return 4

    def GetVariable(self, column):
        return ("b:tnow", "c:loading", "m:u", "m:u")[column]

    def GetObject(self, column):
        return (self.time, self.line, self.nodes[0], self.nodes[1])[column]

    def GetUnit(self, column):
        return ("s", "%", "p.u.", "p.u.")[column]

    def GetColumnValues(self, column):
        nan = float("nan")
        isolated = [1.0, 1.0, 1.0, nan, nan, nan]
        loading = [50, 50, 50, nan, 50, 50] if self.nan_in == "loading" else [50] * 6
        return (self.times, loading, [1.01] * 6, isolated)[column]


def test_a_node_cut_off_by_the_outage_has_no_voltage_instead_of_stopping_the_run():
    engine = worker.engine
    result = ResultWithIsolatedNode(1769817600)
    counters = {}
    series, labels, _times, _unit, _absolute, _origin = engine.collect_series(result, (), counters)
    voltage = {item["element_name"]: item for item in series if item["category"] == "voltage"}
    assert set(voltage) == {"T1", "T2.1"}  # the node is kept: it was energised at the start
    values = [value for _label, _t, value in voltage["T2.1"]["points"]]
    assert values == [1.0, 1.0, 1.0, None, None, None]  # no value while it is isolated
    assert counters["deenergized_steps"] == 3 and counters["deenergized_nodes"] == 0
    # and a database can store it: the missing values become NULL
    assert voltage["T1"]["statistics"]["max"] == 1.01


def test_a_non_finite_loading_still_stops_the_run():
    with pytest.raises(RuntimeError, match="Invalid result value"):
        worker.engine.collect_series(ResultWithIsolatedNode(1769817600, nan_in="loading"), (), {})
