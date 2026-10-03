from datetime import datetime, timezone
import csv
import io
import sqlite3
import pytest
from pydantic import ValidationError
from fastapi.testclient import TestClient
from app.analysis.models import RunBundle
from app.analysis.repository import AnalysisRepository
from app.analysis.service import analyze
from app.core.errors import InvalidRequestError


def bundle(run_id="run-a", values=(80, 100, 120, None), unit="%"):
    return RunBundle.model_validate(
        {
            "run": {
                "id": run_id,
                "name": run_id,
                "project": "Project",
                "study_case": "Case",
                "source": "test",
            },
            "elements": [
                {
                    "id": "stable-1",
                    "name": "=unsafe",
                    "className": "ElmLne",
                    "type": "line",
                    "path": "Project/Line.ElmLne",
                }
            ],
            "metrics": [
                {"id": "loading", "name": "Loading", "unit": unit, "upper": 100}
            ],
            "samples": [
                {
                    "timestamp": f"2026-09-21T0{i}:00:00Z",
                    "element_id": "stable-1",
                    "metric_id": "loading",
                    "value": value,
                }
                for i, value in enumerate(values)
            ],
        }
    )


@pytest.fixture
def repo(tmp_path):
    repository = AnalysisRepository(str(tmp_path / "analysis.sqlite3"))
    repository.import_bundle(bundle())
    yield repository
    repository.close()


def test_statistics_threshold_and_missing_are_consistent(repo):
    data, rows = analyze(repo, "run-a")
    assert data["stats"] == {
        "count": 3,
        "missing": 1,
        "mean": 100,
        "min": 80,
        "max": 120,
        "std_dev": pytest.approx(16.32993161855),
        "p95": 118,
        "violations": 1,
    }
    assert data["elements"][0]["violations"] == 1
    assert sum(b["count"] for b in data["histogram"]) == 3
    assert data["duration"][0]["value"] == 120
    assert data["duration"][-1]["value"] == 80
    assert len(rows) == 4


def test_filters_drive_every_output(repo):
    data, _ = analyze(
        repo,
        "run-a",
        start=datetime(2026, 9, 21, 1, tzinfo=timezone.utc),
        end=datetime(2026, 9, 21, 2, tzinfo=timezone.utc),
    )
    assert data["stats"]["count"] == 2
    assert data["stats"]["mean"] == 110
    assert len(data["points"]) == 2
    empty, _ = analyze(repo, "run-a", search="not found")
    assert (
        empty["stats"]["mean"] is None
        and empty["points"] == []
        and empty["elements"] == []
    )
    empty, _ = analyze(repo, "run-a", element_type="transformer")
    assert empty["stats"]["count"] == 0


def test_comparison_uses_only_valid_matching_pairs(repo):
    repo.import_bundle(bundle("run-b", (70, None, 110, 90)))
    data, _ = analyze(repo, "run-a", compare_run_id="run-b")
    assert data["comparison"]["matched_count"] == 2
    assert data["comparison"]["mean_delta"] == 10
    assert len(data["comparison"]["points"]) == 2


def test_incompatible_units_and_projects_rejected(repo):
    repo.import_bundle(bundle("run-b", unit="MW"))
    with pytest.raises(InvalidRequestError):
        analyze(repo, "run-a", compare_run_id="run-b")
    other = bundle("run-c")
    other.run.project = "Other"
    repo.import_bundle(other)
    with pytest.raises(InvalidRequestError):
        analyze(repo, "run-a", compare_run_id="run-c")


def test_duplicate_import_never_overwrites(repo):
    with pytest.raises(sqlite3.IntegrityError):
        repo.import_bundle(bundle(values=(1, 2, 3, 4)))
    assert analyze(repo, "run-a")[0]["stats"]["mean"] == 100


def test_sql_filter_is_parameterized(repo):
    data, _ = analyze(repo, "run-a", search="' OR 1=1 --")
    assert data["stats"]["count"] == 0
    assert len(repo.runs()) == 1


def test_invalid_window_ids_and_naive_time_rejected(repo):
    with pytest.raises(InvalidRequestError):
        analyze(repo, "run-a", element_ids=["absent"])
    with pytest.raises(InvalidRequestError):
        analyze(repo, "run-a", start=datetime(2026, 9, 21))
    with pytest.raises(InvalidRequestError):
        analyze(
            repo,
            "run-a",
            start=datetime(2026, 9, 22, tzinfo=timezone.utc),
            end=datetime(2026, 9, 21, tzinfo=timezone.utc),
        )


@pytest.mark.parametrize("change", ["nan", "reference", "duplicate", "naive", "bounds"])
def test_import_validation(change):
    data = bundle().model_dump(mode="json")
    if change == "nan":
        data["samples"][0]["value"] = float("nan")
    if change == "reference":
        data["samples"][0]["element_id"] = "absent"
    if change == "duplicate":
        data["samples"].append(data["samples"][0])
    if change == "naive":
        data["samples"][0]["timestamp"] = "2026-01-01T00:00:00"
    if change == "bounds":
        data["metrics"][0]["lower"] = 200
    with pytest.raises(ValidationError):
        RunBundle.model_validate(data)


def test_timestamps_normalize_before_duplicate_detection():
    data = bundle().model_dump(mode="json")
    data["samples"][1]["timestamp"] = "2026-09-21T02:00:00+02:00"
    with pytest.raises(ValidationError):
        RunBundle.model_validate(data)


def test_failed_measurement_is_not_used_as_zero(repo):
    data = bundle("failed")
    data.samples[0].status = "failed"
    repo.import_bundle(data)
    summary = analyze(repo, "failed")[0]["stats"]
    assert summary["mean"] == 110 and summary["missing"] == 2


@pytest.fixture
def client(repo, monkeypatch, tmp_path):
    from app.main import app
    from app.analysis.bootstrap import get_repository
    from app.simulation import settings
    import app.main as main_module

    monkeypatch.setattr(settings, "ANALYSIS_DB_PATH", str(tmp_path / "jobs.sqlite3"))
    monkeypatch.setattr(main_module, "initialize_analysis", lambda: None)
    app.dependency_overrides[get_repository] = lambda: repo
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def test_real_api_export_and_query_agree(client):
    query = "run_id=run-a&start=2026-09-21T01:00:00Z&end=2026-09-21T02:00:00Z"
    response = client.get("/api/analysis/query?" + query)
    assert response.status_code == 200
    assert response.headers.get("x-request-id")
    data = response.json()
    exported = client.get("/api/analysis/export.csv?" + query)
    assert exported.status_code == 200
    rows = list(csv.DictReader(io.StringIO(exported.text.lstrip("\ufeff"))))
    assert len(rows) == data["meta"]["sample_count"] == 2
    assert rows[0]["name"] == "'=unsafe"
    assert rows[0]["element_id"] == "stable-1"
    assert rows[0]["className"] == "ElmLne"
    assert data["stats"]["mean"] == sum(float(row["value"]) for row in rows) / len(rows)


def test_api_errors_are_actionable_and_map_endpoints_absent(client):
    assert client.get("/api/analysis/query?run_id=unknown").status_code == 404
    assert (
        client.get("/api/analysis/query?run_id=run-a&metric_id=unknown").status_code
        == 404
    )
    assert (
        client.get(
            "/api/analysis/query?run_id=run-a&start=2026-01-01T00:00:00"
        ).status_code
        == 400
    )
    assert client.get("/api/grid/topology").status_code == 404
    paths = client.get("/openapi.json").json()["paths"]
    assert not any(p.startswith("/api/map") or "topology" in p for p in paths)


def test_local_data_is_accessible_without_login(client):
    assert client.get("/api/analysis/runs").status_code == 200
    assert client.get("/api/analysis/export.csv?run_id=run-a").status_code == 200
    paths = client.get("/openapi.json").json()["paths"]
    assert not any("auth" in path or "login" in path for path in paths)


def test_schema_migration_is_idempotent_and_data_persists(tmp_path):
    path = str(tmp_path / "p.sqlite3")
    first = AnalysisRepository(path)
    first.import_bundle(bundle())
    first.close()
    second = AnalysisRepository(path)
    assert second.runs()[0]["sample_count"] == 4
    assert (
        second.db.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0] == 1
    )
    second.close()
