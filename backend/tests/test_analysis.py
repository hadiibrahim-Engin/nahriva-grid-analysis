import sqlite3
import pytest
from pydantic import ValidationError
from app.analysis.models import RunBundle
from app.analysis.repository import AnalysisRepository


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


def test_duplicate_import_never_overwrites(repo):
    with pytest.raises(sqlite3.IntegrityError):
        repo.import_bundle(bundle(values=(1, 2, 3, 4)))
    assert repo.runs()[0]["sample_count"] == 4


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
