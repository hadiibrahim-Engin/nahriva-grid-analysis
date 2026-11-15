"""Time-point view, asset explorer and restore package, on synthetic runs through the real import path."""

import json

import pytest
from fastapi.testclient import TestClient

from app.simulation import settings, timepoint, values
from app.simulation.store import ScenarioStore
from tests import large_dataset


@pytest.fixture(scope="module")
def database(tmp_path_factory):
    path = tmp_path_factory.mktemp("timepoint") / "tp.sqlite3"
    outcome = large_dataset.build(path, branches=30, cases=2, contingencies=6, window=24)
    return path, outcome["assessment_id"]


@pytest.fixture
def store(database):
    opened = ScenarioStore(str(database[0]))
    yield opened
    opened.close()


@pytest.fixture
def api(database, monkeypatch):
    monkeypatch.setattr(settings, "ANALYSIS_DB_PATH", str(database[0]))
    monkeypatch.setattr(settings, "ANALYSIS_MODE", "sqlite")
    from app.main import app
    with TestClient(app) as client:
        yield client


def scenario(store):
    return store.db.execute("SELECT * FROM pf_scenarios ORDER BY rowid").fetchone()


def test_the_import_aggregation_equals_the_aggregation_of_the_stored_values(store):
    overloads = 0
    for (run,) in store.db.execute("SELECT DISTINCT run_id FROM pf_scenario_runs").fetchall():
        imported = {r[0]: r[1:] for r in store.db.execute(
            "SELECT t, " + ", ".join(timepoint.TIME_FIELDS) + " FROM pf_run_times WHERE run_id=?", (run,))}
        computed = {r[0]: tuple(r)[1:] for r in values.query(store.db, run, timepoint._FALLBACK_SQL, (run,))}
        assert imported.keys() == computed.keys() and len(imported) > 20
        for t, row in imported.items():
            assert row[1] == computed[t][1] and row[4] == computed[t][4]  # violation counts
            for k in (0, 2, 3):
                assert row[k] == pytest.approx(computed[t][k])
        overloads += sum(row[1] for row in imported.values())
    assert overloads > 0  # the synthetic scenarios overload branches somewhere


def test_scenario_times_rank_the_critical_times_of_the_outage_run(store):
    row = scenario(store)
    result = timepoint.scenario_times(store, row["id"], top=5, points=10 ** 6)  # full resolution
    assert result["interval_steps"] == 1
    assert result["source"] == "import" and len(result["times"]) == len(result["outage"]["loading_max"])
    over = dict(zip(result["times"], result["outage"]["loading_over"]))
    outside = dict(zip(result["times"], result["outage"]["voltage_outside"]))
    scores = [over[t] + outside[t] for t in result["critical"]]
    assert scores == sorted(scores, reverse=True) and scores[0] == max(over[t] + outside[t] for t in result["times"])
    assert len(result["ref"]["loading_max"]) == len(result["times"])


def test_a_long_course_is_reduced_to_the_worst_value_per_interval_at_real_times(store):
    row = scenario(store)
    full = timepoint.scenario_times(store, row["id"], points=10 ** 6)
    reduced = timepoint.scenario_times(store, row["id"], points=100)
    assert len(reduced["times"]) <= 100 and reduced["interval_steps"] > 1
    assert set(reduced["times"]) <= set(full["times"])  # every shown time is a calculated one
    # Peaks and violation counts survive the reduction; the critical times stay at full resolution.
    for field, pick in (("loading_max", max), ("loading_over", max), ("voltage_min", min)):
        assert pick(v for v in reduced["outage"][field] if v is not None) == pick(v for v in full["outage"][field] if v is not None)
    assert reduced["critical"] == full["critical"]


def test_a_time_range_cuts_the_course_and_ranks_the_critical_times_within_it(store, api):
    row = scenario(store)
    full = timepoint.scenario_times(store, row["id"], points=10 ** 6)
    start, end = full["times"][len(full["times"]) // 3], full["times"][2 * len(full["times"]) // 3]
    cut = timepoint.scenario_times(store, row["id"], points=10 ** 6, start=start, end=end)
    assert cut["times"] == [t for t in full["times"] if start <= t <= end]
    assert cut["period"] == full["period"] == [full["times"][0], full["times"][-1]]
    assert all(start <= t <= end for t in cut["critical"])
    assert api.get(f"/api/simulation/scenarios/{row['id']}/times", params={"start": start, "end": end}).json()["times"] == cut["times"]
    assert api.get(f"/api/simulation/scenarios/{row['id']}/times", params={"start": end, "end": start}).status_code == 422


def test_the_snapshot_reads_every_element_at_one_time_against_ref(store):
    row = scenario(store)
    times = timepoint.scenario_times(store, row["id"])
    t = times["critical"][0]
    snap = timepoint.snapshot(store, row["id"], t, "loading", limit=1000)
    branches = store.db.execute(
        "SELECT COUNT(*) FROM analysis_elements e JOIN pf_scenario_runs r ON r.run_id = e.run_id "
        "WHERE r.scenario_id=? AND r.kind='OUTAGE' AND e.type IN ('line','transformer')", (row["id"],)).fetchone()[0]
    assert snap["total"] == branches and snap["in_window"]
    # The worst element first; its value is the stored value at t, the delta is against the REF value at t.
    first = snap["rows"][0]
    run = store.db.execute("SELECT run_id FROM pf_scenario_runs WHERE scenario_id=? AND kind='OUTAGE'", (row["id"],)).fetchone()[0]
    stored = values.query(
        store.db, run, "SELECT v.value FROM analysis_series se JOIN analysis_values v ON v.series_id=se.id AND v.t=? "
        "WHERE se.run_id=? AND se.element_id=? AND se.metric_id='loading'", (t, run, first["element_id"]))[0][0]
    assert first["value"] == stored and first["delta"] == pytest.approx(first["value"] - first["ref"])
    assert snap["violations"] == times["outage"]["loading_over"][times["times"].index(t)]
    # The branch the planned outage switches off is marked, not judged.
    outaged = [r for r in snap["rows"] if r["outaged"]]
    assert len(outaged) == 1 and outaged[0]["state"] == "outaged" and outaged[0]["name"] in row["name"]
    assert sum(snap["distribution"]["outage"]) == branches - 1
    # Pages and filters.
    page = timepoint.snapshot(store, row["id"], t, "loading", limit=5, offset=5)
    assert [r["element_id"] for r in page["rows"]] == [r["element_id"] for r in snap["rows"][5:10]]
    north = timepoint.snapshot(store, row["id"], t, "loading", limit=1000, grid="North")
    assert north["total"] == sum(1 for r in snap["rows"] if r["grid"] == "North") > 0
    assert timepoint.snapshot(store, row["id"], t, "loading", kv=380.0)["total"] == 0
    voltage = timepoint.snapshot(store, row["id"], t, "voltage", limit=1000)
    assert voltage["total"] == branches and all(r["lower"] is not None for r in voltage["rows"])


def test_the_restore_package_names_what_powerfactory_needs_and_what_is_missing(store):
    row = scenario(store)
    package = timepoint.restore_package(store, row["id"])
    assert package["schema"] == "outage-assessment.restore-package" and package["reproducible"] == "partial"
    outage = package["scenario"]["planned_outages"][0]
    assert outage["path"].endswith(".IntPlannedout") and outage["start"] < outage["end"]
    assert package["scenario"]["case_id"] == "C1" and package["scenario"]["windows"]
    assert package["analysis"]["native_run_id"] and package["analysis"]["settings"] is not None
    assert {r["kind"] for r in package["native_results"]} == {"QDS", "n-1", "(n-1)'"}
    assert any("operation scenario" in item for item in package["limitations"])
    late = timepoint.restore_package(store, row["id"], t=outage["end"] + 10 * 86400)
    assert late["time"]["epoch"] == outage["end"] + 10 * 86400
    assert any("outside the outage windows" in item for item in late["limitations"])


def test_the_asset_view_follows_one_element_through_every_scenario_and_its_n1(store, database):
    branch = store.db.execute(
        "SELECT element_id FROM gl_n1_columns k JOIN gl_columns c ON c.result_id=k.result_id AND c.column_id=k.column_id "
        "WHERE k.metric='loading' ORDER BY k.violation_times DESC LIMIT 1").fetchone()[0]
    result = timepoint.asset(store, branch, database[1])
    assert result["element"]["nominal_kv"] == 110 and result["element"]["mrid"] is None
    assert len(result["scenarios"]) == 2 and all(s["kind"] == "branch" for s in result["scenarios"])
    assert {"REF", "OUTAGE"} <= set(result["scenarios"][0]["components"])
    assert {n["kind"] for n in result["n1"]} == {"n-1", "(n-1)'"} and all(n["contingency_name"] for n in result["n1"])
    assert timepoint.asset(store, "no-such-element", database[1]) is None


def test_the_api_serves_the_new_views(api, database):
    analysis = database[1]
    scenario_id = api.get("/api/simulation/across-scenarios/index").json()["scenarios"][0]["id"]
    times = api.get(f"/api/simulation/scenarios/{scenario_id}/times").json()
    t = times["critical"][0]
    snap = api.get(f"/api/simulation/scenarios/{scenario_id}/snapshot", params={"t": t, "limit": 3}).json()
    assert len(snap["rows"]) == 3 and snap["total"] > 3
    assert api.get(f"/api/simulation/scenarios/{scenario_id}/snapshot", params={"t": t, "metric": "current"}).status_code == 422
    assert api.get("/api/simulation/scenarios/unknown/times").status_code == 404
    assert api.get("/api/simulation/voltage-levels").json() == [{"kv": 110.0, "elements": 60}]
    package = api.get(f"/api/simulation/scenarios/{scenario_id}/restore-package", params={"t": t}).json()
    assert json.dumps(package) and package["time"]["epoch"] == t
    element = snap["rows"][0]["element_id"]
    assert api.get(f"/api/simulation/assets/{element}", params={"analysis": analysis}).json()["element"]["element_id"] == element
    overview = api.get("/api/simulation/outage-management").json()
    assert overview["analysis"] == analysis and len(overview["scenarios"]) == 2


def test_a_large_scenario_sends_every_element_a_verdict_or_key_figure_depends_on(store, monkeypatch):
    from app.simulation import across

    monkeypatch.setattr(across, "FULL_LIST_LIMIT", 10)  # the test network counts as large
    for row in store.db.execute("SELECT id FROM pf_scenarios").fetchall():
        full = across.scenario_cells(store, row["id"])
        cut = across.relevant_cells(full, warning=80.0, band=(0.95, 1.05), margin=0.02, top=3)
        assert cut["listing"]["lines"] == len(full["lines"]) and cut["listing"]["listed_lines"] == len(cut["lines"])
        assert len(cut["lines"]) < len(full["lines"])  # something was left out
        listed = {item["id"] for item in cut["lines"]}
        value = lambda item: item["cell"]["value"] or 0  # noqa: E731
        for item in full["lines"]:
            cell = item["cell"]
            if cell["outaged"] or value(item) >= 80 or (cell["window_base"] or 0) >= 80 or any(cell["hours_over"] or ()):
                assert item["id"] in listed, item["name"]
        # The key figures come out the same: highest loading, largest change, branches above 100 %.
        assert max(map(value, cut["lines"])) == max(map(value, full["lines"]))
        largest = lambda items: max(abs(i["cell"]["delta"] or 0) for i in items)  # noqa: E731
        assert largest(cut["lines"]) == largest(full["lines"])
        assert sum(value(i) > 100 for i in cut["lines"]) == sum(value(i) > 100 for i in full["lines"])
        outside = {b["id"] for b in full["buses"] if b["cell"]["out"] and not 0.97 <= b["cell"]["out"][0] <= b["cell"]["out"][1] <= 1.03}
        assert outside <= {b["id"] for b in cut["buses"]}
    # Small scenarios are never cut.
    monkeypatch.setattr(across, "FULL_LIST_LIMIT", 10 ** 6)
    row = store.db.execute("SELECT id FROM pf_scenarios").fetchone()
    assert "listing" not in across.relevant_cells(across.scenario_cells(store, row["id"]))
