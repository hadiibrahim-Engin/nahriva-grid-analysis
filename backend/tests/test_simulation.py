from fastapi.testclient import TestClient
import pytest
from urllib.parse import quote
from app.analysis.repository import AnalysisRepository
from app.analysis.bootstrap import get_repository
from app.simulation import settings, data
from app.simulation.store import ScenarioStore, catalog_signature
from tests.test_analysis import bundle


@pytest.fixture
def api(tmp_path, monkeypatch):
    import app.main as main

    path = tmp_path / "simulation.sqlite3"
    repo = AnalysisRepository(str(path))
    repo.import_bundle(bundle())
    monkeypatch.setattr(settings, "ANALYSIS_MODE", "sqlite")
    monkeypatch.setattr(settings, "ANALYSIS_DB_PATH", str(path))
    monkeypatch.setattr(main, "initialize_analysis", lambda: None)
    main.app.dependency_overrides[get_repository] = lambda: repo
    with TestClient(main.app) as client:
        yield client, path
    main.app.dependency_overrides.clear()
    repo.close()


def test_original_dashboard_contract_reads_the_simulation_database(api):
    client, _ = api
    facilities = client.get("/api/simulation/facilities").json()
    assert facilities[0]["id"] == "run-a"
    components = client.get("/api/simulation/facilities/run-a/components").json()
    identifier = components[0]["id"]
    assert client.get(
        f"/api/simulation/components/{identifier}/measurement-types"
    ).json() == [{"type": "L", "unit": "%"}]
    url = f"/api/simulation/timeseries/raw/{identifier}/L?start=2026-09-21T00:00:00&end=2026-09-21T03:00:00&limit=2"
    first = client.get(url).json()
    assert [p["value"] for p in first["data"]] == [80, 100]
    assert first["meta"]["source"] == "simulation" and first["next_cursor"]
    second = client.get(url + "&cursor=" + quote(first["next_cursor"], safe="")).json()
    assert [p["value"] for p in second["data"]] == [120]
    mean = client.get(
        f"/api/simulation/timeseries/aggregate/{identifier}/L?start=2026-09-21T00:00:00&end=2026-09-21T03:00:00&bucket=86400"
    ).json()
    assert (
        mean["data"][0]["value"] == 100 and mean["meta"]["aggregation_method"] == "AVG"
    )
    assert client.get("/api/facilities").status_code == 404
    paths = client.get("/openapi.json").json()["paths"]
    assert not any("fdwh" in p.lower() or "oracle" in p.lower() for p in paths)


def test_offset_and_naive_chart_windows_are_both_normalized_as_utc():
    assert (
        data.parse_time("2026-01-01T02:00:00-02:00").isoformat()
        == "2026-01-01T04:00:00+00:00"
    )
    assert (
        data.parse_time("2026-01-01T02:00:00").isoformat()
        == "2026-01-01T02:00:00+00:00"
    )


def test_unfiltered_series_returns_the_entire_stored_simulation(api):
    client, _ = api
    identifier = client.get("/api/simulation/facilities/run-a/components").json()[0][
        "id"
    ]
    response = client.get(f"/api/simulation/timeseries/raw/{identifier}/L")
    assert response.status_code == 200
    assert [p["value"] for p in response.json()["data"]] == [80, 100, 120]
    assert (
        client.get(
            f"/api/simulation/timeseries/aggregate/{identifier}/L?bucket=86400"
        ).status_code
        == 200
    )
    assert client.get("/api/simulation/auth/login").status_code == 404


def test_calendar_of_an_epoch_second_matches_the_datetime_it_stands_for():
    from datetime import datetime, timezone

    calendar = data._Calendar()
    for epoch in (0, 86399, 86400, 1767225600, 1769817600 + 3 * 86400 + 7, 1780000000, 1798675200, 1735689599):
        moment = datetime.fromtimestamp(epoch, timezone.utc)
        assert calendar.day(epoch) == (moment.weekday(), moment.month, moment.date().isoformat())
        assert epoch // 3600 % 24 == moment.hour


def test_the_native_step_is_the_smallest_positive_gap_in_seconds():
    assert data.native_step([0, 900, 1800, 2700]) == 900.0
    assert data.native_step([0, 900, 2700, 3600]) == 900.0  # a gap does not change it
    assert data.native_step([5]) == 0 and data.native_step([]) == 0
