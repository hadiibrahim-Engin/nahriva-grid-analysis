"""Load, generation and transit per area: recorded active power, summed at import, consistent with the flows."""

import pytest
from fastapi.testclient import TestClient

from app.simulation import areas, across, settings, timepoint
from app.simulation.store import ScenarioStore
from tests import ieee39, large_dataset


@pytest.fixture(scope="module")
def example(tmp_path_factory):
    path = tmp_path_factory.mktemp("areas") / "ieee39.sqlite3"
    ieee39.build(path, runs=(1.0,))
    return path


@pytest.fixture
def store(example):
    opened = ScenarioStore(str(example))
    yield opened
    opened.close()


def first_scenario(store):
    return across.scenario_index(store)["scenarios"][0]["id"]


def test_recorded_power_makes_balance_and_flows_possible(store):
    _row, runs = timepoint._scenario(store, first_scenario(store))
    able = areas.capability(store.db, runs["OUTAGE"])
    assert able["balance"] and able["flows"] and able["missing"] == []
    assert able["recorded"] == {"loads": len(ieee39.LOADS), "sources": len(ieee39.GENERATORS),
                                "branches": len(ieee39.LINES) + len(ieee39.TRANSFORMERS)}
    ties = store.db.execute("SELECT COUNT(*) FROM gl_branch_ends WHERE from_grid != to_grid").fetchone()[0]
    assert ties > 0  # branches between two areas, read from their terminals at import


def test_an_area_balance_equals_the_flows_over_its_tie_branches(store):
    _row, runs = timepoint._scenario(store, first_scenario(store))
    times, flows = areas._read(store.db, runs["OUTAGE"], None, None)
    _stamps, series = areas._series(times, flows)
    assert set(series) == set(ieee39.AREAS)
    for area, s in series.items():
        for net, imported, exported in zip(s["net"], s["import"], s["export"]):
            assert net == pytest.approx(exported - imported, abs=1e-3)  # DC load flow: lossless
    total = [sum(s["net"][i] for s in series.values()) for i in range(len(_stamps))]
    assert max(abs(x) for x in total) < 1e-3  # what one area exports another imports


def test_the_view_summarises_areas_against_ref_and_reduces_long_courses(store):
    view = areas.area_view(store, first_scenario(store), points=50)
    assert view["capability"]["balance"] and len(view["areas"]) == 3
    row = view["areas"][0]
    assert row["ref"] and row["load_peak"] >= row["load_mean"] > 0
    assert len(view["times"]) <= 50 and view["interval_steps"] > 1
    assert all(len(c["load"]) == len(view["times"]) for c in view["course"].values())
    assert {f["from"] for f in view["flows"]} <= set(ieee39.AREAS)
    assert len(view["days"]) == len(next(iter(view["daily"].values()))["net_mean"])


def test_a_branch_flow_is_stored_once_per_pair_with_the_sign_of_the_pair():
    summary = areas.AreaTimes(2)
    summary.add("line", "North", [10.0, None], ends=("West", "North"))  # flows from West into North
    summary.add("line", "North", [5.0, 5.0], ends=("North", "West"))
    summary.add("line", "North", [7.0, 7.0], ends=("North", "North"))  # inside one area: no flow between areas
    assert summary.flows == {("North", "West"): [-10.0 + 5.0, 0.0 + 5.0]}


def test_without_recorded_power_the_dashboard_says_what_is_missing(tmp_path, monkeypatch):
    path = tmp_path / "plain.sqlite3"
    large_dataset.build(path, branches=6, cases=1, contingencies=0, window=24)
    monkeypatch.setattr(settings, "ANALYSIS_DB_PATH", str(path))
    from app.main import app
    with TestClient(app) as client:
        scenario = client.get("/api/simulation/across-scenarios/index").json()["scenarios"][0]["id"]
        result = client.get(f"/api/simulation/scenarios/{scenario}/areas").json()
        assert result["capability"]["balance"] is False and len(result["capability"]["missing"]) == 3
        assert "areas" not in result  # no numbers without the data
        assert client.get("/api/simulation/scenarios/nope/areas").status_code == 404
        assert client.get(f"/api/simulation/scenarios/{scenario}/areas", params={"start": 2, "end": 1}).status_code == 422
