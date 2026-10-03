import sqlite3

from fastapi.testclient import TestClient
import pytest

from app.analysis.bootstrap import get_repository
from app.analysis.repository import AnalysisRepository
from app.simulation import settings
from app.simulation.store import ScenarioStore
from tests.test_analysis import bundle


@pytest.fixture
def databases(tmp_path, monkeypatch):
    from app.main import app

    paths = [tmp_path / "first.sqlite3", tmp_path / "second.sqlite3"]
    for index, path in enumerate(paths):
        store = ScenarioStore(str(path))
        store.close()
        result = bundle()
        result.run.name = f"Scenario {index}"
        for sample in result.samples:
            if sample.value is not None:
                sample.value += index * 50
        repo = AnalysisRepository(str(path))
        repo.import_bundle(result)
        repo.close()
    monkeypatch.setattr(settings, "ANALYSIS_MODE", "sqlite")
    monkeypatch.setattr(settings, "ANALYSIS_DB_PATH", str(paths[0]))
    with TestClient(app) as client:
        yield client, paths


def test_switch_reads_new_results_and_keeps_existing_requests_alive(databases):
    client, paths = databases
    old_repo = get_repository()
    assert client.get("/api/simulation/facilities").json()[0]["name"] == "Scenario 0"
    response = client.post("/api/simulation/database", json={"path": str(paths[1])})
    assert response.status_code == 200
    assert response.json()["path"] == str(paths[1])
    assert client.get("/api/health/ready").json()["database_path"] == str(paths[1])
    assert client.get("/api/simulation/database").json()["path"] == str(paths[1])
    assert client.get("/api/simulation/facilities").json()[0]["name"] == "Scenario 1"
    identifier = client.get("/api/simulation/facilities/run-a/components").json()[0][
        "id"
    ]
    series = client.get(f"/api/simulation/timeseries/raw/{identifier}/L").json()
    assert [point["value"] for point in series["data"]] == [130, 150, 170]
    assert old_repo.runs()[0]["name"] == "Scenario 0"
    assert (
        client.post(
            "/api/simulation/database", json={"path": str(paths[0])}
        ).status_code
        == 200
    )
    assert client.get("/api/simulation/facilities").json()[0]["name"] == "Scenario 0"


def test_invalid_paths_and_foreign_or_future_databases_leave_selection_intact(
    databases, tmp_path
):
    client, paths = databases
    missing = tmp_path / "typo.sqlite3"
    text = tmp_path / "text.sqlite3"
    text.write_text("not SQLite")
    foreign = tmp_path / "foreign.sqlite3"
    with sqlite3.connect(foreign) as db:
        db.execute("CREATE TABLE unrelated (id INTEGER)")
    with sqlite3.connect(paths[1]) as db:
        db.execute("UPDATE schema_migrations SET version=999")
    for path in (missing, text, foreign, paths[1], "relative.sqlite3"):
        response = client.post("/api/simulation/database", json={"path": str(path)})
        assert response.status_code == 422
        assert client.get("/api/simulation/database").json()["path"] == str(paths[0])
        assert (
            client.get("/api/simulation/facilities").json()[0]["name"] == "Scenario 0"
        )
    assert not missing.exists()
    with sqlite3.connect(foreign) as db:
        assert db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall() == [("unrelated",)]
