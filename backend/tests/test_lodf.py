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

# LODF in % at bus1 per contingency: line -> value. D is small: only recorded when the limit is 0.
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
    """Study Case with a Contingency Analysis and 'Sensitivities / Distribution Factors', like the real one."""

    def __init__(self, unsolvable=("E",), distribution_class=PFObject, with_combined=False, with_tool=True):
        super().__init__()
        self.lines = {name: PFObject(name, "ElmLne", outserv=0) for name in "ABCD"}
        self.lines["E"] = PFObject("E", "ElmTr2", outserv=0)  # a generator step-up transformer
        self.outages[0].components = [self.lines["A"]]
        self.outages[1].components = [self.lines["C"]]
        self.contingencies = {}
        for name in ("A", "C", "E") + (("A+C",) if with_combined else ()):
            contingency = PFObject(name, "ComOutage", outserv=0)
            members = [self.lines[part] for part in name.split("+")]
            contingency.GetObject = lambda line, members=members: members[line] if line < len(members) else None
            contingency.GetContents = lambda *args: []
            self.contingencies[name] = contingency
        self.unsolvable = set(unsolvable)
        self.rows = []
        self.simulation = PFObject("Contingency Analysis", "ComSimoutage")
        self.simulation.GetContents = lambda *args: list(self.contingencies.values())
        self.result = PFObject("Distribution Factors Results (SYM)_LODF", "ElmRes")
        self.result.GetContents = lambda *args: []
        self.result.Load = self.result.Release = lambda: None
        self.result.GetNumberOfRows = lambda: len(self.rows)
        self.result.GetNumberOfColumns = lambda: len(self.columns())
        self.result.GetVariable = lambda column: self.columns()[column][0]
        self.result.GetObject = lambda column: self.columns()[column][1] or self.result
        self.result.GetObj = lambda index: self.rows[-index - 1][0] if -len(self.rows) <= index <= -1 else None
        self.result.GetValue = self.value
        holder = PFObject("Distribution Factors Results (SYM)", "ElmRes")
        holder.GetContents = lambda *args: [self.result]
        self.distribution = distribution_class(
            "Sensitivities / Distribution Factors", "ComVstab", calcLodf=1, lodflim=10,
            pComSimoutage=self.simulation, pResult=holder)
        self.distribution.GetContents = lambda *args: []
        self.distribution.runs = []
        self.distribution.Execute = self.execute
        self.fail_with = None
        self.printed = []
        self.PrintPlain = self.printed.append
        tools = {"*.ComVstab": [self.distribution] if with_tool else [], "*.ComSimoutage": [self.simulation]}
        self.study.GetContents = lambda pattern, *args: tools.get(pattern, [])

    def columns(self):
        columns = [("b:index", None), ("b:calcmod", None), ("b:outid", None)]
        for name in "ABCD":
            columns += [("m:LODF:bus1", self.lines[name]), ("m:LODF:bus2", self.lines[name])]
        return columns

    def execute(self):
        self.distribution.runs.append((self.distribution.calcLodf, self.distribution.lodflim))
        if self.fail_with is not None:
            if isinstance(self.fail_with, Exception):
                raise self.fail_with
            return self.fail_with
        limit = self.distribution.lodflim
        self.rows = []
        for name, contingency in self.contingencies.items():
            if name in self.unsolvable or name not in PERCENT:
                continue
            values = {line: v for line, v in PERCENT[name].items() if abs(v) >= limit}
            self.rows.append((contingency, values))
        if self.distribution.__class__ is LockedDistribution:
            self.distribution.locked = True
        return 0

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


def test_equipment_that_is_no_contingency_is_named_so_it_can_be_added():
    app = NativeApp()
    rows, undefined = calculate(app, [scenario(app, "d", "D")])
    assert rows == []
    assert "D is no contingency of the Contingency Analysis" in undefined["d"] and "add it" in undefined["d"]


def test_a_combined_outage_needs_a_contingency_with_exactly_this_equipment():
    app = NativeApp()
    rows, undefined = calculate(app, [scenario(app, "ac", "A", "C")])
    assert rows == [] and "no contingency" in undefined["ac"]
    app = NativeApp(with_combined=True)
    rows, undefined = calculate(app, [scenario(app, "ac", "C", "A")])  # the order does not matter
    assert {r[1]: r[2] for r in rows} == {"B": 1.0} and undefined == {}


def test_an_outage_without_equipment_is_reported():
    app = NativeApp()
    rows, undefined = calculate(app, [scenario(app, "busbar")])
    assert rows == [] and "switches no line, transformer or coupler" in undefined["busbar"]


def test_a_study_case_without_the_tool_stops_the_lodf_with_a_clear_message():
    import lodf

    app = NativeApp(with_tool=False)
    with pytest.raises(lodf.LodfError, match="has no 'Sensitivities / Distribution Factors' command"):
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


def test_the_lodf_tool_missing_or_failing_does_not_stop_the_assessment(tmp_path):
    app = NativeApp(with_tool=False)
    assert assessment_module().run_assessment(app, tmp_path / "none.sqlite3") == ["Chosen", "Other"]
    assert any("WARN" in m and "ComVstab" in m for m in app.printed)
    app = NativeApp()
    app.fail_with = 1
    assert assessment_module().run_assessment(app, tmp_path / "fail.sqlite3") == ["Chosen", "Other"]
    assert lodf_rows(tmp_path / "fail.sqlite3") == {}


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
