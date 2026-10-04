"""Across-scenarios aggregation: windowed maxima, like-for-like deltas, LODF, switched-off lines."""

from pathlib import Path
import sys
from app.simulation.across import across_scenarios
from app.simulation.store import ScenarioStore

from tests.qds_fixture import create_dummy_database


def load(tmp_path):
    store = ScenarioStore(str(create_dummy_database(tmp_path / "demo.sqlite3")))
    result = across_scenarios(store)
    store.close()
    ids = {s["name"]: s["id"] for s in result["scenarios"]}
    lines = {line["name"]: line for line in result["lines"]}
    return result, ids, lines


def test_buses_are_excluded_and_every_scenario_is_listed(tmp_path):
    result, ids, lines = load(tmp_path)
    assert {line["type"] for line in lines.values()} == {"line", "transformer"}  # all branch equipment
    assert len(ids) == 8 and len(lines) == 10
    assert not any("Busbar" in name for name in lines)
    assert result["has_lodf"]


def test_scenario_value_delta_and_lodf_for_single_outage(tmp_path):
    _, ids, lines = load(tmp_path)
    cell = lines["Line North–East"]["cells"][ids["Outage Line North"]]
    assert round(cell["value"], 1) == 128.2  # 64 % base + 64 pp inside the outage window
    assert round(cell["delta"], 1) == 64.2  # like for like: REF maximum in the same window
    assert round(cell["lodf"], 2) == 0.55
    assert lines["Line North–East"]["base"] == 64.0


def test_switched_off_line_has_no_value_and_no_delta(tmp_path):
    _, ids, lines = load(tmp_path)
    cell = lines["Line North–West"]["cells"][ids["Outage Line North"]]
    assert cell["outaged"] and cell["value"] is None and cell["delta"] is None


def test_unaffected_line_has_zero_delta(tmp_path):
    _, ids, lines = load(tmp_path)
    cell = lines["Transformer North T1"]["cells"][ids["Outage Line South"]]
    assert not cell["outaged"] and abs(cell["delta"]) < 1e-9


def test_endpoint_returns_the_aggregation_read_only(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.simulation import settings

    path = create_dummy_database(tmp_path / "demo.sqlite3")
    monkeypatch.setattr(settings, "ANALYSIS_MODE", "sqlite")
    monkeypatch.setattr(settings, "ANALYSIS_DB_PATH", str(path))
    with TestClient(app) as client:
        body = client.get("/api/simulation/across-scenarios").json()
    assert len(body["scenarios"]) == 8 and len(body["lines"]) == 10 and body["has_lodf"]
    store = ScenarioStore(str(path))
    assert store.db.execute("SELECT COUNT(*) FROM pf_scenarios").fetchone()[0] == 8
    store.close()


def test_overload_time_relates_to_the_simulation_period_not_to_scenarios(tmp_path):
    result, ids, lines = load(tmp_path)
    assert result["period_hours"] == 168.0  # 672 steps of 15 minutes
    cell = lines["Line Central–South"]["cells"][ids["Outage Line South"]]
    assert cell["outaged"] and cell["hours_over"] is None
    cell = lines["Line North–East"]["cells"][ids["Outage Line North"]]
    over100, over110, over120 = cell["hours_over"]
    assert 0 < over120 <= over110 <= over100 < 24  # only inside the one-day outage window
    quiet = lines["Transformer North T1"]["cells"][ids["Outage Line South"]]
    assert quiet["hours_over"] == [0.0, 0.0, 0.0]


def test_busbars_carry_voltage_ranges_limits_and_hours_outside_the_band(tmp_path):
    result, ids, _ = load(tmp_path)
    buses = {bus["name"]: bus for bus in result["buses"]}
    assert set(buses) == {"Busbar North", "Busbar South", "Busbar East"}
    south = buses["Busbar South"]
    assert south["limits"] == [0.9, 1.1]
    assert result["voltage_unit"] == "p.u."
    cell = south["cells"][ids["Outage Transformer South"]]
    assert cell["out"][0] < 0.9 <= cell["ref"][0]  # band violated by the outage, REF within the band
    assert cell["hours_outside"] > 0
    calm = south["cells"][ids["Outage Line North"]]
    assert calm["hours_outside"] == 0
    east = buses["Busbar East"]["cells"][ids["Outage Line East"]]
    assert east["out"][1] > 1.1 >= east["ref"][1]  # overvoltage


def test_profile_lists_the_most_critical_in_service_branches(tmp_path):
    from app.simulation.across import scenario_profile

    store = ScenarioStore(str(create_dummy_database(tmp_path / "demo.sqlite3")))
    scenario = next(s for s in across_scenarios(store)["scenarios"] if s["name"] == "Outage Transformer South")
    profile = scenario_profile(store, scenario["id"], top=3, points=100)
    assert [s["name"] for s in profile["series"]][0] == "Line South–West"
    assert "Transformer South T2" not in [s["name"] for s in profile["series"]]  # switched off in this scenario
    assert len(profile["times"]) <= 100 and len(profile["series"][0]["out"]) == len(profile["times"])
    assert max(v for v in profile["series"][0]["out"] if v is not None) > 100
    assert len(profile["windows"]) == 1
    assert scenario_profile(store, "missing") is None
    store.close()


def test_store_can_be_closed_from_another_thread(tmp_path):
    """FastAPI opens a request-scoped store in one worker thread and may close it in another."""
    import threading

    store = ScenarioStore(str(tmp_path / "t.sqlite3"))
    errors = []

    def close():
        try:
            store.close()
        except Exception as exc:  # pragma: no cover - the failure being tested
            errors.append(exc)

    thread = threading.Thread(target=close)
    thread.start()
    thread.join()
    assert errors == []


def test_index_reads_no_samples_and_cells_are_cached(tmp_path):
    from app.simulation import across

    store = ScenarioStore(str(create_dummy_database(tmp_path / "demo.sqlite3")))
    statements = []
    store.db.set_trace_callback(statements.append)
    index = across.scenario_index(store)
    assert len(index["scenarios"]) == 8 and index["has_lodf"]
    assert not any("analysis_values" in sql for sql in statements)  # nothing heavy for the overview
    store.db.set_trace_callback(None)

    across._CELLS_CACHE.hits = 0
    first = across.scenario_cells(store, index["scenarios"][0]["id"])
    again = across.scenario_cells(store, index["scenarios"][0]["id"])
    assert again is first and across._CELLS_CACHE.hits == 1
    assert across.scenario_cells(store, "missing") is None
    store.close()


def test_per_scenario_cells_compose_to_the_combined_payload(tmp_path):
    from app.simulation import across

    store = ScenarioStore(str(create_dummy_database(tmp_path / "demo.sqlite3")))
    index = across.scenario_index(store)
    parts = {s["id"]: across.scenario_cells(store, s["id"]) for s in index["scenarios"]}
    # Merging the parts of only the first scenarios (progressive loading) keeps their order and values.
    first_two = {k: v for k, v in list(parts.items())[:2]}
    partial = across.merge_cells(index, first_two)
    full = across.across_scenarios(store)
    assert [s["id"] for s in partial["scenarios"]] == [s["id"] for s in index["scenarios"][:2]]
    assert len(full["scenarios"]) == 8 and len(full["lines"]) == 10 and len(full["buses"]) == 3
    line = next(item for item in full["lines"] if item["name"] == "Line North–East")
    sid = next(s["id"] for s in full["scenarios"] if s["name"] == "Outage Line North")
    assert round(line["cells"][sid]["value"], 1) == 128.2 and line["base"] == 64.0
    store.close()


def test_lazy_endpoints_serve_index_and_cells(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.simulation import settings

    path = create_dummy_database(tmp_path / "demo.sqlite3")
    monkeypatch.setattr(settings, "ANALYSIS_MODE", "sqlite")
    monkeypatch.setattr(settings, "ANALYSIS_DB_PATH", str(path))
    with TestClient(app) as client:
        index = client.get("/api/simulation/across-scenarios/index").json()
        first = index["scenarios"][0]["id"]
        cells = client.get(f"/api/simulation/across-scenarios/{first}/cells").json()
        assert client.get("/api/simulation/across-scenarios/missing/cells").status_code == 404
    assert cells["scenario_id"] == first and len(cells["lines"]) == 10 and len(cells["buses"]) == 3
    assert "cell" in cells["lines"][0] and "ref_full" in cells["lines"][0]


def test_grid_comes_from_the_powerfactory_path():
    from app.simulation.grids import grid_name

    assert grid_name(r"\User\P.IntPrj\Network Model.IntPrjfolder\Network Data.IntPrjfolder\D7 Grid.ElmNet\L1.ElmLne") == "D7 Grid"
    assert grid_name(r"\User\P.IntPrj\D7 Grid.ElmNet\Site.ElmSite\S1.ElmSubstat\BB.ElmTerm") == "D7 Grid"
    assert grid_name("Dummy/Line North") == ""
    assert grid_name(None) == ""


def test_grid_filter_data_lists_lines_buses_components_and_profile(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.simulation import settings

    path = create_dummy_database(tmp_path / "grids.sqlite3")
    store = ScenarioStore(str(path))
    north = ("line-north", "line-northeast", "transformer-north", "bus-north")
    with store.db:
        for element_id in north:
            store.db.execute(
                "UPDATE analysis_elements SET path='\\Dummy.IntPrj\\D7 Grid.ElmNet\\' || name WHERE id=?", (element_id,)
            )
        store.db.execute(
            "UPDATE analysis_elements SET path='\\Dummy.IntPrj\\D8 Grid.ElmNet\\' || name WHERE path NOT LIKE '%.ElmNet%'"
        )
    store.close()
    monkeypatch.setattr(settings, "ANALYSIS_MODE", "sqlite")
    monkeypatch.setattr(settings, "ANALYSIS_DB_PATH", str(path))
    with TestClient(app) as client:
        assert client.get("/api/simulation/grids").json() == [
            {"name": "D7 Grid", "elements": 4},
            {"name": "D8 Grid", "elements": 9},
        ]
        body = client.get("/api/simulation/across-scenarios").json()
        assert {line["name"]: line["grid"] for line in body["lines"]}["Line North–East"] == "D7 Grid"
        assert {bus["name"]: bus["grid"] for bus in body["buses"]}["Busbar South"] == "D8 Grid"
        run_id = client.get("/api/simulation/facilities").json()[0]["id"]
        components = client.get(f"/api/simulation/facilities/{run_id}/components").json()
        assert {c["grid"] for c in components} == {"D7 Grid", "D8 Grid"}
        scenario = next(s for s in body["scenarios"] if s["name"] == "Outage Line South")
        profile = client.get(
            f"/api/simulation/across-scenarios/{scenario['id']}/profile", params={"grid": "D7 Grid", "top": 10}
        ).json()
        assert profile["series"] and all(s["id"] in north for s in profile["series"])
