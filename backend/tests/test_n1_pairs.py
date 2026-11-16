"""n-1 as pairs "contingency -> overloaded branch": checked against the DC load flow of the IEEE 39-bus example."""

import pytest
from fastapi.testclient import TestClient

from app.simulation import across, gridlens_store, settings
from app.simulation.store import ScenarioStore
from tests import ieee39


@pytest.fixture
def store(ieee39_example):
    opened = ScenarioStore(str(ieee39_example))
    yield opened
    opened.close()


def maintenance(store):
    scenario = across.scenario_index(store)["scenarios"][0]
    return scenario, next(o for o in ieee39.Ieee39().outages if o.loc_name == scenario["name"])


def test_each_pair_is_the_load_flow_after_that_contingency(store):
    scenario, outage = maintenance(store)
    result = gridlens_store.n1_pairs(store.db, scenario["id"], "(n-1)'", limit=20)
    pairs = result["pairs"]
    assert result["total_pairs"] >= len(pairs) > 0 and result["before"] == "planning case"
    assert [p["post"] for p in pairs] == sorted((p["post"] for p in pairs), reverse=True)
    model = ieee39.Ieee39()
    names = [b.loc_name for b in model.branches]
    for p in pairs[:5]:
        branch, fault = names.index(p["element"]), names.index(p["contingency"])
        assert p["post"] == pytest.approx(model.n1_loading(branch, fault, p["t"], (outage,), None), rel=1e-9)
        assert p["pre"] == pytest.approx(model.loading(branch, p["t"], (outage,)), rel=1e-9)
        assert p["post"] > p["limit"] and p["hours_over"] > 0
    # The maintained branch is switched off: it neither fails again nor carries flow.
    maintained = outage.loc_name.replace("Maintenance ", "")
    assert all(maintained not in (p["contingency"], p["element"]) for p in pairs)


def test_the_sweep_without_maintenance_compares_with_ref(store):
    scenario, _outage = maintenance(store)
    plain = gridlens_store.n1_pairs(store.db, scenario["id"], "n-1", limit=5)
    assert plain["before"] == "REF" and plain["kind"] == "n-1"
    assert gridlens_store.n1_pairs(store.db, "nope-C1", "n-1") is None


def test_the_api_filters_by_time_and_rejects_unknown_kinds(store, ieee39_example, monkeypatch):
    scenario, _outage = maintenance(store)
    monkeypatch.setattr(settings, "ANALYSIS_DB_PATH", str(ieee39_example))
    from app.main import app
    with TestClient(app) as client:
        url = f"/api/simulation/scenarios/{scenario['id']}/n1-pairs"
        full = client.get(url, params={"limit": 2000}).json()
        first = min(p["t"] for p in full["pairs"])
        cut = client.get(url, params={"limit": 2000, "end": first}).json()
        assert all(p["t"] <= first for p in cut["pairs"]) and cut["total_pairs"] < full["total_pairs"]
        assert client.get(url, params={"kind": "n-2"}).status_code == 422


def test_the_global_grid_and_voltage_filters_keep_the_overloaded_branches_there(store):
    scenario, _outage = maintenance(store)
    every = gridlens_store.n1_pairs(store.db, scenario["id"], limit=100_000)
    north = gridlens_store.n1_pairs(store.db, scenario["id"], limit=100_000, grid="Area North")
    assert 0 < north["total_pairs"] < every["total_pairs"]
    assert {p["grid"] for p in north["pairs"]} == {"Area North"}
    assert {p["contingency"] for p in north["pairs"]} - {p["element"] for p in north["pairs"]}  # outages from elsewhere
    assert gridlens_store.n1_pairs(store.db, scenario["id"], kv=16.5)["total_pairs"] == 0  # generator terminals


def test_plot_equipment_filters_are_applied_before_the_top_n_limit(store):
    scenario, _outage = maintenance(store)
    every = gridlens_store.n1_pairs(store.db, scenario["id"], limit=100_000)
    assert every["pairs"]
    chosen_id = every["pairs"][-1]["element_id"]

    chosen = gridlens_store.n1_pairs(store.db, scenario["id"], limit=1, element_ids=[chosen_id])
    assert chosen["total_pairs"] > 0
    assert len(chosen["pairs"]) == 1
    assert chosen["pairs"][0]["element_id"] == chosen_id

    lines = gridlens_store.n1_pairs(store.db, scenario["id"], limit=100_000, equipment="line")
    assert all(pair["type"] == "line" for pair in lines["pairs"])
