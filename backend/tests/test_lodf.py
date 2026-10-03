"""LODF is calculated natively before any simulation and stored with the results."""

import sqlite3

import pytest

from app.simulation.store import ScenarioStore, outage_key
from tests.test_powerfactory_worker import App, PFObject, assessment_module, worker


class Branch(PFObject):
    def __init__(self, name, flow, network):
        super().__init__(name, "ElmLne", outserv=0)
        self.flow = flow
        self.network = network

    def GetAttribute(self, name):
        if name != "m:P:bus1":
            raise AttributeError(name)
        return self.network.flow(self)


class Network:
    """A carries 100 MW; when it trips B takes 60 % and C 40 %."""

    def __init__(self):
        self.a = Branch("A", 100.0, self)
        self.b = Branch("B", 50.0, self)
        self.c = Branch("C", 30.0, self)

    def flow(self, branch):
        if branch.outserv:
            return 0.0
        if self.a.outserv and branch is self.b:
            return branch.flow + 60.0
        if self.a.outserv and branch is self.c:
            return branch.flow + 40.0
        return branch.flow


class LodfApp(App):
    def __init__(self, status=0):
        super().__init__()
        self.network = Network()
        self.status = status
        self.ldf = PFObject("Load Flow", "ComLdf", iopt_net=0)
        self.ldf.Execute = lambda: self.status
        self.outages[0].components = [self.network.a]
        self.outages[1].components = [self.network.c]

    def GetCalcRelevantObjects(self, pattern, *args):
        n = self.network
        return [n.a, n.b, n.c] if pattern == "*.ElmLne" else []

    def GetFromStudyCase(self, kind):
        return self.ldf if kind == "ComLdf" else super().GetFromStudyCase(kind)


def lodf_rows(path):
    with sqlite3.connect(path) as db:
        return {
            (r[0], r[1]): r[2:]
            for r in db.execute("SELECT outage_key,element_id,lodf,p_pre,p_post FROM pf_lodf")
        }


def test_lodf_is_stored_before_simulation_and_state_restored(tmp_path):
    app = LodfApp()
    path = tmp_path / "lodf.sqlite3"
    assessment_module().run_assessment(app, path)
    chosen = outage_key([worker.identifier(app.outages[0].GetFullName())])
    project = app.GetActiveProject().GetFullName()
    rows = lodf_rows(path)
    b = rows[(chosen, worker.identifier(project + "|" + app.network.b.GetFullName()))]
    c = rows[(chosen, worker.identifier(project + "|" + app.network.c.GetFullName()))]
    assert [round(v, 6) for v in b] == [0.6, 50.0, 110.0]
    assert [round(v, 6) for v in c] == [0.4, 30.0, 70.0]
    assert (chosen, worker.identifier(project + "|" + app.network.a.GetFullName())) not in rows
    assert app.ldf.iopt_net == 0
    assert [x.outserv for x in (app.network.a, app.network.b, app.network.c)] == [0, 0, 0]


def test_failed_load_flow_warns_but_assessment_still_runs(tmp_path):
    app = LodfApp(status=1)
    path = tmp_path / "nolodf.sqlite3"
    messages = []
    app.PrintPlain = messages.append
    assert assessment_module().run_assessment(app, path) == ["Chosen", "Other"]
    assert any("WARN" in m and "converge" in m for m in messages)
    assert lodf_rows(path) == {}
    assert app.ldf.iopt_net == 0
    store = ScenarioStore(str(path))
    assert len(store.overview()["scenarios"]) == 2
    store.close()


def test_missing_load_flow_object_is_not_fatal(tmp_path):
    app = LodfApp()
    app.ldf = None
    assert assessment_module().run_assessment(app, tmp_path / "x.sqlite3") == ["Chosen", "Other"]


class StuckBranch(Branch):
    """A branch that refuses to be switched off (the write does not stick)."""

    def __setattr__(self, name, value):
        if name == "outserv" and value == 1 and "network" in self.__dict__:
            return
        super().__setattr__(name, value)


def test_a_branch_that_cannot_be_switched_off_leaves_no_other_branch_switched_off():
    import lodf

    app = LodfApp()
    stuck = StuckBranch("D", 20.0, app.network)
    scenario = {"key": "k", "equipment": [app.network.a, stuck]}
    with pytest.raises(lodf.LodfError, match="Could not switch off"):
        lodf.calculate(app, [scenario], lambda branch: branch.loc_name)
    assert app.network.a.outserv == 0  # switched off first, must be restored although the second failed
    assert app.ldf.iopt_net == 0


def test_branches_that_are_out_of_service_from_the_start_do_not_abort_the_calculation():
    import lodf

    app = LodfApp()
    app.network.c.outserv = 1  # already out of service in the study case: carries no flow
    rows = lodf.calculate(app, [{"key": "k", "equipment": [app.network.a]}], lambda branch: branch.loc_name)
    assert {row[1] for row in rows} == {"B"}  # monitored: only branches in service; C is skipped, not an error
    assert app.network.c.outserv == 1
