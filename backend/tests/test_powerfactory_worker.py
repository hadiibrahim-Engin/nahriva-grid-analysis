"""Exercise PF state restoration and atomic persistence with a native-API fake."""

import importlib.util
import sqlite3
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


def queue(app, path, name="D7 · Wartung Nord"):
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
    assert app.calls == [(0, ["Chosen"]), (1, ["Chosen"])]
    with sqlite3.connect(path) as db:
        assert (
            db.execute("SELECT name FROM pf_scenarios").fetchone()[0]
            == "D7 · Wartung Nord"
        )
        assert db.execute("SELECT COUNT(*) FROM analysis_samples").fetchone()[0] == 600
        assert (
            db.execute(
                "SELECT COUNT(DISTINCT timestamp) FROM analysis_samples"
            ).fetchone()[0]
            == 300
        )
        assert (
            db.execute("SELECT status FROM pf_jobs WHERE id=?", (job_id,)).fetchone()[0]
            == "completed"
        )
        assert (
            db.execute(
                "SELECT DISTINCT value FROM analysis_samples WHERE run_id LIKE '%OUTAGE'"
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
        "samples": [("unknown", "loading", "2026-01-31T00:00:00+00:00", 1, "ok")],
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
    assert app.calls == [
        (0, ["Chosen"]),
        (1, ["Chosen"]),
        (0, ["Other"]),
        (1, ["Other"]),
    ]
    store = ScenarioStore(str(path))
    assert {s["name"] for s in store.overview()["scenarios"]} == {"Chosen", "Other"}
    assert (
        store.db.execute("SELECT COUNT(*) FROM analysis_samples").fetchone()[0] == 1200
    )
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
    assert app.calls == [(0, ["Chosen", "Other"]), (1, ["Chosen", "Other"])]
    restored(app)
