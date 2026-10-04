"""Local repositories; retain previous connections until shutdown for active requests."""

from pathlib import Path
from contextlib import closing
import sqlite3
from threading import RLock
from app.simulation import settings
from app.analysis import schema
from app.analysis.repository import AnalysisRepository

_repositories = {}
_lock = RLock()


def get_repository():
    with _lock:
        path = str(Path(settings.ANALYSIS_DB_PATH).expanduser().resolve())
        if path not in _repositories:
            _repositories[path] = AnalysisRepository(path)
        return _repositories[path]


def select_database(value):
    """Only attach an existing, compatible results file; never create a typo path."""
    path = Path(value).expanduser()
    if not path.is_absolute() or not path.is_file():
        raise ValueError(
            "Please enter the absolute path of an existing results database."
        )
    path = path.resolve()
    try:
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
            required = {
                "schema_migrations",
                "analysis_runs",
                "analysis_elements",
                "analysis_metrics",
                "analysis_series",
                "analysis_values",
                "pf_catalog",
                "pf_jobs",
                "pf_scenarios",
                "pf_scenario_runs",
                "pf_element_limits",
            }
            tables = {
                row[0]
                for row in db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            if "schema_migrations" in tables:
                schema.check_version(db)  # an earlier version is named as such, not as "not a results database"
            if not required.issubset(tables):
                raise ValueError(
                    "The file is not an Outage Assessment results database."
                )
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("The SQLite database is corrupt.")
            db.execute(
                "SELECT series_id, t, value FROM analysis_values LIMIT 0"
            )
            db.execute(
                "SELECT id, name, project, study_case, source, status FROM analysis_runs LIMIT 0"
            )
        with _lock:
            if str(path) not in _repositories:
                _repositories[str(path)] = AnalysisRepository(str(path))
            settings.ANALYSIS_DB_PATH = str(path)
            settings.ANALYSIS_MODE = "sqlite"
    except (sqlite3.Error, OSError, RuntimeError) as exc:
        raise ValueError(
            "The results database could not be opened: " + str(exc)
        ) from exc
    return str(path)


def initialize_analysis():
    get_repository()


def close_repositories():
    with _lock:
        for repo in _repositories.values():
            repo.close()
        _repositories.clear()
