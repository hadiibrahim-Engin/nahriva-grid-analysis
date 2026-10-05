"""LODF comes from PowerFactory's own 'Sensitivities / Distribution Factors' (ComVstab) before any simulation.

The fake mirrors what a real PowerFactory 2026 run showed: the values are in the result file "..._LODF" inside
ComVstab.pResult, one row per calculated contingency, columns m:LODF:bus1/bus2 per line in %, header column
b:outid (ElmRes.GetObj(negative outid) = the contingency), values below ComVstab.lodflim are not written
(return code 3), a contingency without a solution has no row.
"""

import sqlite3

import pytest

from app.simulation.store import ScenarioStore, outage_key
from tests.test_powerfactory_worker import App, PFObject, assessment_module, worker

# LODF in % at bus1 per contingency (named by its equipment): line -> value. D is small: only recorded when the limit is 0.
PERCENT = {
    "A": {"B": 60.0, "C": 40.0, "D": 4.0},
    "C": {"A": 70.0, "B": 30.0, "D": 2.0},
    "A+C": {"B": 100.0},
    "E": {"A": 5.0},  # E has no solution: never written
}


class LockedDistribution(PFObject):
    """A ComVstab that rejects writes to lodflim once it has run, like a PowerFactory object that went away."""

    def __setattr__(self, name, value):
        if self.__dict__.get("locked") and name == "lodflim":
            raise RuntimeError("object already deleted")
        super().__setattr__(name, value)


class NativeApp(App):
    """A Study Case like the real one: a Contingency Analysis of the user, optionally 'Sensitivities / Distribution
    Factors'. What the script creates (its own Contingency Analysis, contingencies, the command) behaves like PowerFactory:
    CreateObject, SetObjs, GetObject, ClearCont, Delete; the tool calculates the contingencies of the analysis it is linked to.
    """

    def __init__(self, unsolvable=("E",), distribution_class=PFObject, with_tool=True, fail_create=None, fail_setobjs=False):
        super().__init__()
        self.lines = {name: PFObject(name, "ElmLne", outserv=0) for name in "ABCD"}
        self.lines["E"] = PFObject("E", "ElmTr2", outserv=0)  # a generator step-up transformer
        self.outages[0].components = [self.lines["A"]]
        self.outages[1].components = [self.lines["C"]]
        self.unsolvable = set(unsolvable)
        self.distribution_class = distribution_class
        self.fail_create, self.fail_setobjs = fail_create, fail_setobjs
        self.rows = []
        self.deleted = []
        self.analyses = []
        self.user_analysis = self.new_analysis(None, "Contingency Analysis")  # the user's, with contingencies of its own
        for name in ("A", "C", "E"):
            self.add_contingency(self.user_analysis, name, [self.lines[part] for part in name.split("+")])
        self.result = PFObject("Distribution Factors Results (SYM)_LODF", "ElmRes")
        self.result.GetContents = lambda *args: []
        self.result.Load = self.result.Release = lambda: None
        self.result.GetNumberOfRows = lambda: len(self.rows)
        self.result.GetNumberOfColumns = lambda: len(self.columns())
        self.result.GetVariable = lambda column: self.columns()[column][0]
        self.result.GetObject = lambda column: self.columns()[column][1] or self.result
        self.result.GetObj = lambda index: self.rows[-index - 1][0] if -len(self.rows) <= index <= -1 else None
        self.result.GetValue = self.value
        self.holder = PFObject("Distribution Factors Results (SYM)", "ElmRes")
        self.holder.GetContents = lambda *args: [self.result]
        self.distribution = None
        self.printed = []
        self.PrintPlain = self.printed.append
        self.study.GetContents = self.study_contents
        self.study.CreateObject = self.study_create
        self.GetFromStudyCase = self.from_study_case
        if with_tool:
            self.make_distribution("Sensitivities / Distribution Factors", self.user_analysis)

    def make_distribution(self, name, analysis):
        self.distribution = self.distribution_class(name, "ComVstab", calcLodf=1, lodflim=10, pComSimoutage=analysis, pResult=self.holder)
        self.distribution.GetContents = lambda *args: []
        self.distribution.runs = []
        self.distribution.Execute = self.execute
        self.distribution.Delete = lambda: self.deleted.append(name) or 0
        return self.distribution

    def new_analysis(self, parent, name):
        analysis = PFObject(name, "ComSimoutage")
        analysis.members = []
        analysis.GetContents = lambda *args: list(analysis.members)
        analysis.CreateObject = lambda class_name, name: self.create_contingency(analysis, class_name, name)
        analysis.ClearCont = lambda: analysis.members.clear() or 0
        analysis.Delete = lambda: self.deleted.append(name) or 0
        self.analyses.append(analysis)
        return analysis

    def add_contingency(self, analysis, name, equipment):
        contingency = PFObject(name, "ComOutage", outserv=0)
        contingency.equipment = list(equipment)
        contingency.GetObject = lambda line: contingency.equipment[line] if line < len(contingency.equipment) else None
        contingency.GetContents = lambda *args: []
        contingency.SetObjs = lambda objs: 1 if self.fail_setobjs else (setattr(contingency, "equipment", list(objs)) or 0)
        analysis.members.append(contingency)
        return contingency

    def create_contingency(self, analysis, class_name, name):
        assert class_name == "ComOutage"
        return self.add_contingency(analysis, name, [])

    def study_contents(self, pattern, *args):
        if pattern == "*.ComVstab":
            return [self.distribution] if self.distribution is not None else []
        if pattern == "*.ComSimoutage":
            return list(self.analyses)
        return []

    def study_create(self, class_name, name):
        if self.fail_create:
            raise RuntimeError(self.fail_create)
        assert class_name == "ComSimoutage"
        return self.new_analysis(self.study, name)

    def from_study_case(self, kind):
        if kind == "ComVstab":
            return self.distribution or self.make_distribution("Sensitivities / Distribution Factors", None)
        return (self.qds if kind == "ComStatsim" else self.clock if kind == "SetTime" else None)

    @staticmethod
    def label(contingency):
        return "+".join(sorted(item.loc_name for item in contingency.equipment))

    def columns(self):
        columns = [("b:index", None), ("b:calcmod", None), ("b:outid", None)]
        for name in "ABCD":
            columns += [("m:LODF:bus1", self.lines[name]), ("m:LODF:bus2", self.lines[name])]
        return columns

    def execute(self):
        self.distribution.runs.append((self.distribution.calcLodf, self.distribution.lodflim))
        self.calculated = self.distribution.pComSimoutage  # the analysis the tool is linked to while it runs
        if self.fail_with is not None:
            if isinstance(self.fail_with, Exception):
                raise self.fail_with
            return self.fail_with
        limit = self.distribution.lodflim
        self.rows = []
        for contingency in self.calculated.members:
            name = self.label(contingency)
            if name in self.unsolvable or name not in PERCENT:
                continue
            values = {line: v for line, v in PERCENT[name].items() if abs(v) >= limit}
            self.rows.append((contingency, values))
        if self.distribution.__class__ is LockedDistribution:
            self.distribution.locked = True
        return 0

    fail_with = None
    calculated = None

    def value(self, row, column):
        variable, line = self.columns()[column]
        contingency, values = self.rows[row]
        if variable == "b:index":
            return (0, 6.0 + row)
        if variable == "b:calcmod":
            return (0, 0.0)
        if variable == "b:outid":
            return (0, -float(row + 1))
        name = line.loc_name
        if name not in values:
            return (3, 1e35)  # not written
        return (0, values[name] if variable.endswith("bus1") else -values[name])


def scenario(app, name, *equipment):
    return {"key": name, "name": name, "equipment": [app.lines[e] for e in equipment]}


def calculate(app, scenarios):
    import lodf

    undefined = {}
    rows = lodf.calculate(app, scenarios, lambda line: line.loc_name, app.printed.append, undefined)
    return rows, undefined


def lodf_rows(path):
    with sqlite3.connect(path) as db:
        return {(r[0], r[1]): r[2:] for r in db.execute("SELECT outage_key,element_id,lodf,p_pre,p_post FROM pf_lodf")}


def test_the_values_of_the_matching_contingency_are_read_as_signed_fractions():
    app = NativeApp()
    rows, undefined = calculate(app, [scenario(app, "a", "A")])
    assert {r[1]: round(r[2], 6) for r in rows} == {"B": 0.6, "C": 0.4, "D": 0.04}  # % at bus1 -> fraction
    assert all(r[0] == "a" and r[3] is None and r[4] is None for r in rows)  # PowerFactory gives no flows
    assert undefined == {}


def test_every_value_is_recorded_and_the_settings_are_put_back():
    app = NativeApp()
    calculate(app, [scenario(app, "c", "C")])
    assert app.distribution.runs == [(1, 0)]  # LODF on and the recording limit 0 during the run
    assert app.distribution.lodflim == 10 and app.distribution.calcLodf == 1  # as they were


def test_a_switched_off_lodf_calculation_is_switched_on_and_back_off():
    app = NativeApp()
    app.distribution.calcLodf = 0
    calculate(app, [scenario(app, "a", "A")])
    assert app.distribution.runs == [(1, 0)] and app.distribution.calcLodf == 0


def test_an_outage_without_a_solution_is_not_defined_while_the_others_keep_their_values():
    app = NativeApp()
    rows, undefined = calculate(app, [scenario(app, "a", "A"), scenario(app, "e", "E")])
    assert {r[0] for r in rows} == {"a"}
    assert list(undefined) == ["e"] and "no solution without E" in undefined["e"]
    assert any("not defined" in m for m in app.printed)


def test_a_contingency_is_created_for_every_scenario_so_nothing_has_to_be_defined_by_hand():
    app = NativeApp()
    rows, undefined = calculate(app, [scenario(app, "d", "D")])
    # D has no entry in the fake's results: PowerFactory found no solution, which is named, not "add it yourself"
    assert rows == [] and "no solution without D" in undefined["d"]
    mine = [a for a in app.analyses if a.loc_name == "Outage Assessment"]
    assert len(mine) == 1 and [c.loc_name for c in mine[0].members] == ["d"]


def test_a_combined_outage_gets_one_contingency_with_all_its_equipment():
    app = NativeApp()
    rows, undefined = calculate(app, [scenario(app, "ac", "C", "A")])  # the order does not matter
    assert {r[1]: r[2] for r in rows} == {"B": 1.0} and undefined == {}


def test_an_outage_without_equipment_is_reported():
    app = NativeApp()
    rows, undefined = calculate(app, [scenario(app, "busbar")])
    assert rows == [] and "switches no line, transformer or coupler" in undefined["busbar"]


def test_the_missing_command_and_contingency_analysis_are_created_and_reported():
    app = NativeApp(with_tool=False)
    rows, undefined = calculate(app, [scenario(app, "a", "A")])
    assert {r[1] for r in rows} == {"B", "C", "D"}
    text = "\n".join(app.printed)
    assert "Created 'Sensitivities / Distribution Factors'" in text and "Created Contingency Analysis 'Outage Assessment'" in text
    assert "Contingencies created in 'Outage Assessment': a (A)" in text and "Left in Study Case" in text
    assert app.deleted == []  # kept for inspection by default
    assert app.distribution.pComSimoutage.loc_name == "Outage Assessment"  # a command the user can open and run


def test_the_contingency_analysis_of_the_user_is_not_touched_and_stays_linked():
    app = NativeApp()
    calculate(app, [scenario(app, "a", "A")])
    assert [c.loc_name for c in app.user_analysis.members] == ["A", "C", "E"]
    assert app.calculated.loc_name == "Outage Assessment"  # the tool ran on ours ...
    assert app.distribution.pComSimoutage is app.user_analysis  # ... and the user's link is back


def test_an_earlier_analysis_is_emptied_and_reused_not_duplicated():
    app = NativeApp()
    calculate(app, [scenario(app, "a", "A")])
    calculate(app, [scenario(app, "c", "C")])
    mine = [a for a in app.analyses if a.loc_name == "Outage Assessment"]
    assert len(mine) == 1 and [c.loc_name for c in mine[0].members] == ["c"]


def test_what_a_run_created_is_deleted_when_asked(monkeypatch):
    import lodf

    monkeypatch.setattr(lodf, "CLEAN_UP", True)
    app = NativeApp(with_tool=False)
    calculate(app, [scenario(app, "a", "A")])
    assert app.deleted == ["Outage Assessment", "Sensitivities / Distribution Factors"]  # analysis first, then the command


def test_creating_in_the_study_case_can_fail_with_a_clear_message():
    import lodf

    with pytest.raises(lodf.LodfError, match="could not create 'Outage Assessment.ComSimoutage' in 'Study': project is read-only"):
        calculate(NativeApp(fail_create="project is read-only"), [scenario(app := NativeApp(), "a", "A")])
    with pytest.raises(lodf.LodfError, match="does not list its equipment"):
        app = NativeApp(fail_setobjs=True)
        calculate(app, [scenario(app, "a", "A")])


def test_a_failing_execution_stops_the_lodf_and_the_settings_are_restored():
    import lodf

    app = NativeApp()
    app.fail_with = 1
    with pytest.raises(lodf.LodfError, match="error code 1"):
        calculate(app, [scenario(app, "a", "A")])
    assert app.distribution.lodflim == 10
    app.fail_with = RuntimeError("licence expired")
    with pytest.raises(lodf.LodfError, match="licence expired"):
        calculate(app, [scenario(app, "a", "A")])
    assert app.distribution.lodflim == 10


def test_a_result_file_that_is_missing_or_not_understood_is_named():
    import lodf

    app = NativeApp()
    app.distribution.pResult.GetContents = lambda *args: []
    with pytest.raises(lodf.LodfError, match="no result file ending with '_LODF'"):
        calculate(app, [scenario(app, "a", "A")])
    app = NativeApp()
    app.columns = lambda: [("b:index", None)]
    with pytest.raises(lodf.LodfError, match="has no 'b:outid' column"):
        calculate(app, [scenario(app, "a", "A")])


def test_a_restoration_failure_is_reported_with_the_setting_and_the_values():
    import lodf

    app = NativeApp(distribution_class=LockedDistribution)
    with pytest.raises(RuntimeError) as caught:
        calculate(app, [scenario(app, "a", "A")])
    assert not isinstance(caught.value, lodf.LodfError)
    assert "ComVstab.lodflim" in str(caught.value) and "expected 10" in str(caught.value) and "read back 0" in str(caught.value)


def test_lodf_is_stored_before_simulation_and_the_assessment_goes_on(tmp_path):
    app = NativeApp()
    path = tmp_path / "lodf.sqlite3"
    assert assessment_module().run_assessment(app, path) == ["Chosen", "Other"]
    chosen = outage_key([worker.identifier(app.outages[0].GetFullName())])
    project = app.GetActiveProject().GetFullName()
    rows = lodf_rows(path)
    b = rows[(chosen, worker.identifier(project + "|" + app.lines["B"].GetFullName()))]
    assert round(b[0], 6) == 0.6 and b[1] is None and b[2] is None
    assert app.distribution.lodflim == 10  # the Study Case is as it was
    store = ScenarioStore(str(path))
    assert len(store.overview()["scenarios"]) == 2
    store.close()


def test_a_missing_command_is_created_and_a_failing_one_does_not_stop_the_assessment(tmp_path):
    app = NativeApp(with_tool=False)
    assert assessment_module().run_assessment(app, tmp_path / "none.sqlite3") == ["Chosen", "Other"]
    assert lodf_rows(tmp_path / "none.sqlite3")  # the command was created, the LODF is there
    app = NativeApp()
    app.fail_with = 1
    assert assessment_module().run_assessment(app, tmp_path / "fail.sqlite3") == ["Chosen", "Other"]
    assert lodf_rows(tmp_path / "fail.sqlite3") == {}
    assert any("WARN" in m and "error code 1" in m for m in app.printed)


def test_a_not_defined_lodf_is_stored_with_its_reason_for_the_dashboard(tmp_path):
    from app.simulation import across

    app = NativeApp()
    app.outages[1].components = [app.lines["E"]]  # the second planned outage switches off the transformer
    path = tmp_path / "undefined.sqlite3"
    assert assessment_module().run_assessment(app, path) == ["Chosen", "Other"]
    store = ScenarioStore(str(path))
    index = {s["name"]: s for s in across.scenario_index(store)["scenarios"]}
    assert index["Chosen"]["has_lodf"] and index["Chosen"]["lodf_note"] is None
    assert not index["Other"]["has_lodf"] and "no solution without E" in index["Other"]["lodf_note"]
    assert "no solution" in store.db.execute("SELECT reason FROM v_lodf_undefined WHERE scenario='Other'").fetchone()[0]
    # a later calculation replaces the old state
    store.save_lodf([("x", "e", 0.1, None, None)], {})
    store.save_lodf([], {"x": "no LODF"})
    assert store.db.execute("SELECT COUNT(*) FROM pf_lodf WHERE outage_key='x'").fetchone()[0] == 0
    store.close()


def test_scenarios_with_the_same_outages_share_one_calculation(tmp_path):
    app = NativeApp()
    definitions = [{"name": "X", "outages": ["Chosen"]}, {"name": "Y", "outages": ["Chosen"]}]
    assessment_module().run_assessment(app, tmp_path / "same.sqlite3", definitions)
    assert len(app.distribution.runs) == 1  # PowerFactory's tool runs once, however many scenarios
