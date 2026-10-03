"""Local repositories; retain previous connections until shutdown for active requests."""

from pathlib import Path
from contextlib import closing
import sqlite3
from threading import RLock
from app.simulation import settings
from app.analysis.repository import AnalysisRepository

_repositories = {}
_lock = RLock()


def get_repository():
    with _lock:
        path = (
            ":memory:"
            if settings.ANALYSIS_MODE == "demo"
            else str(Path(settings.ANALYSIS_DB_PATH).expanduser().resolve())
        )
        if path not in _repositories:
            repo = AnalysisRepository(path)
            if path == ":memory:":
                from app.analysis.seed import demo_bundles

                for bundle in demo_bundles():
                    repo.import_bundle(bundle)
            _repositories[path] = repo
        return _repositories[path]


def select_database(value):
    """Only attach an existing, compatible results file; never create a typo path."""
    path = Path(value).expanduser()
    if not path.is_absolute() or not path.is_file():
        raise ValueError(
            "Bitte den absoluten Pfad einer vorhandenen Ergebnisdatenbank angeben."
        )
    path = path.resolve()
    try:
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
            required = {
                "schema_migrations",
                "analysis_runs",
                "analysis_elements",
                "analysis_metrics",
                "analysis_samples",
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
            if not required.issubset(tables):
                raise ValueError(
                    "Die Datei ist keine Outage-Assessment-Ergebnisdatenbank."
                )
            if (
                db.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
                != 1
            ):
                raise ValueError("Die Datenbankversion wird nicht unterstützt.")
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("Die SQLite-Datenbank ist beschädigt.")
            db.execute(
                "SELECT run_id, element_id, metric_id, timestamp, value, status FROM analysis_samples LIMIT 0"
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
            "Die Ergebnisdatenbank konnte nicht geöffnet werden: " + str(exc)
        ) from exc
    return str(path)


def initialize_analysis():
    get_repository()


def close_repositories():
    with _lock:
        for repo in _repositories.values():
            repo.close()
        _repositories.clear()
