"""Analysis A against B and scenario A against B, on two synthetic analyses through the real import path."""

import pytest
from fastapi.testclient import TestClient

from app.simulation import across, compare, settings
from app.simulation.store import ScenarioStore
from tests import large_dataset


@pytest.fixture(scope="module")
def database(tmp_path_factory):
    path = tmp_path_factory.mktemp("compare") / "two.sqlite3"
    large_dataset.build(path, branches=20, cases=2, contingencies=0, window=24)
    large_dataset.build(path, branches=25, cases=2, contingencies=0, window=24)  # a later run with more elements
    return path


@pytest.fixture
def store(database):
    opened = ScenarioStore(str(database))
    yield opened
    opened.close()


@pytest.fixture
def api(database, monkeypatch):
    monkeypatch.setattr(settings, "ANALYSIS_DB_PATH", str(database))
    monkeypatch.setattr(settings, "ANALYSIS_MODE", "sqlite")
    from app.main import app
    with TestClient(app) as client:
        yield client


def two_analyses(store):
    found = across.analyses(store.db)
    assert len(found) == 2
    return found[1]["id"], found[0]["id"]  # older, newer


def test_two_analyses_name_what_differs_and_pair_their_scenarios(store):
    older, newer = two_analyses(store)
    result = compare.compare_analyses(store, older, newer)
    checks = {c["check"]: c for c in result["checks"]}
    assert checks["Project"]["status"] == "ok" and checks["Settings"]["status"] == "ok"
    assert checks["Monitored elements"]["status"] == "warning"  # the later run monitors more elements
    paired = [p for p in result["pairs"] if p["a"] and p["b"]]
    assert paired and all(p["a"]["equipment"] == p["b"]["equipment"] for p in paired)
    assert all(p["delta_loading_max"] == pytest.approx(p["b"]["loading_max"] - p["a"]["loading_max"])
               for p in paired if p["delta_loading_max"] is not None)
    assert "settings" not in result["a"]  # the full settings stay on the server, only the differences travel


def test_a_scenario_pair_lists_every_element_with_both_values_largest_change_first(store):
    older, newer = two_analyses(store)
    pair = next(p for p in compare.compare_analyses(store, older, newer)["pairs"] if p["a"] and p["b"])
    result = compare.compare_scenarios(store, pair["a"]["id"], pair["b"]["id"], "loading", limit=10 ** 6)
    rows = result["rows"]
    assert result["counts"]["total"] == len(rows) and result["counts"]["only_b"] > 0 and result["counts"]["only_a"] == 0
    for row in rows:
        if row["state"] == "value":
            assert row["delta"] == pytest.approx(row["b"] - row["a"])
        if row["state"] == "only_b":
            assert row["a"] is None and row["delta"] is None  # missing is never 0
    changes = [abs(r["delta"]) for r in rows if r["delta"] is not None]
    assert changes == sorted(changes, reverse=True)
    assert rows[-1]["delta"] is None  # elements without a change value come last


def test_the_comparison_api_pages_filters_and_rejects_unknown_ids(store, api):
    older, newer = two_analyses(store)
    assert api.get("/api/simulation/compare/analyses", params={"a": older, "b": "nope"}).status_code == 404
    pair = next(p for p in api.get("/api/simulation/compare/analyses", params={"a": older, "b": newer}).json()["pairs"]
                if p["a"] and p["b"])
    params = {"a": pair["a"]["id"], "b": pair["b"]["id"], "metric": "voltage", "limit": 3, "offset": 1}
    page = api.get("/api/simulation/compare/scenarios", params=params).json()
    assert len(page["rows"]) == 3 and page["offset"] == 1 and page["filtered"] == page["counts"]["total"]
    assert all(len(r["a"]) == 2 for r in page["rows"])  # lowest and highest voltage
    searched = api.get("/api/simulation/compare/scenarios", params={**params, "q": "B1", "offset": 0}).json()
    assert searched["rows"] and all("b1" in r["name"].lower() for r in searched["rows"])
    assert api.get("/api/simulation/compare/scenarios", params={**params, "b": "nope"}).status_code == 404
    assert api.get("/api/simulation/compare/scenarios", params={**params, "metric": "x"}).status_code == 422
