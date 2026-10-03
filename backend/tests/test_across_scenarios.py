"""Across-scenarios aggregation: windowed maxima, like-for-like deltas, LODF, switched-off lines."""

from pathlib import Path
import sys
from app.simulation.across import across_scenarios
from app.simulation.store import ScenarioStore

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from seed_dummy_qds import create_dummy_database


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
    assert not any("Sammelschiene" in name for name in lines)
    assert result["has_lodf"]


def test_scenario_value_delta_and_lodf_for_single_outage(tmp_path):
    _, ids, lines = load(tmp_path)
    cell = lines["Leitung Nord–Ost"]["cells"][ids["Freischaltung Leitung Nord"]]
    assert round(cell["value"], 1) == 128.2  # 64 % base + 64 pp inside the outage window
    assert round(cell["delta"], 1) == 64.2  # like for like: REF maximum in the same window
    assert round(cell["lodf"], 2) == 0.55
    assert lines["Leitung Nord–Ost"]["base"] == 64.0


def test_switched_off_line_has_no_value_and_no_delta(tmp_path):
    _, ids, lines = load(tmp_path)
    cell = lines["Leitung Nord–West"]["cells"][ids["Freischaltung Leitung Nord"]]
    assert cell["outaged"] and cell["value"] is None and cell["delta"] is None


def test_unaffected_line_has_zero_delta(tmp_path):
    _, ids, lines = load(tmp_path)
    cell = lines["Trafo Nord T1"]["cells"][ids["Freischaltung Leitung Süd"]]
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
    cell = lines["Leitung Mitte–Süd"]["cells"][ids["Freischaltung Leitung Süd"]]
    assert cell["outaged"] and cell["hours_over"] is None
    cell = lines["Leitung Nord–Ost"]["cells"][ids["Freischaltung Leitung Nord"]]
    over100, over110, over120 = cell["hours_over"]
    assert 0 < over120 <= over110 <= over100 < 24  # only inside the one-day outage window
    quiet = lines["Trafo Nord T1"]["cells"][ids["Freischaltung Leitung Süd"]]
    assert quiet["hours_over"] == [0.0, 0.0, 0.0]


def test_busbars_carry_voltage_ranges_limits_and_hours_outside_the_band(tmp_path):
    result, ids, _ = load(tmp_path)
    buses = {bus["name"]: bus for bus in result["buses"]}
    assert set(buses) == {"Sammelschiene Nord", "Sammelschiene Süd", "Sammelschiene Ost"}
    south = buses["Sammelschiene Süd"]
    assert south["limits"] == [0.9, 1.1]
    assert result["voltage_unit"] == "p.u."
    cell = south["cells"][ids["Freischaltung Trafo Süd"]]
    assert cell["out"][0] < 0.9 <= cell["ref"][0]  # band violated by the outage, REF within the band
    assert cell["hours_outside"] > 0
    calm = south["cells"][ids["Freischaltung Leitung Nord"]]
    assert calm["hours_outside"] == 0
    east = buses["Sammelschiene Ost"]["cells"][ids["Freischaltung Leitung Ost"]]
    assert east["out"][1] > 1.1 >= east["ref"][1]  # overvoltage


def test_profile_lists_the_most_critical_in_service_branches(tmp_path):
    from app.simulation.across import scenario_profile

    store = ScenarioStore(str(create_dummy_database(tmp_path / "demo.sqlite3")))
    scenario = next(s for s in across_scenarios(store)["scenarios"] if s["name"] == "Freischaltung Trafo Süd")
    profile = scenario_profile(store, scenario["id"], top=3, points=100)
    assert [s["name"] for s in profile["series"]][0] == "Leitung Süd–West"
    assert "Trafo Süd T2" not in [s["name"] for s in profile["series"]]  # switched off in this scenario
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
