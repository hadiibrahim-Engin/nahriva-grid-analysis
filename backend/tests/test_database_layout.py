"""Storage layout, one-time set-up and the read-only views for external tools."""

import sqlite3

import pytest

from app.simulation.store import ScenarioStore
from tests.qds_fixture import create_dummy_database


VERSION_1 = """
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
INSERT INTO schema_migrations VALUES (1);
CREATE TABLE analysis_samples (
    run_id TEXT NOT NULL, element_id TEXT NOT NULL, metric_id TEXT NOT NULL,
    timestamp TEXT NOT NULL, value REAL, status TEXT NOT NULL,
    PRIMARY KEY (run_id, metric_id, element_id, timestamp)
);
"""


def table_sql(db, name):
    return db.execute("SELECT sql FROM sqlite_master WHERE name=?", (name,)).fetchone()[0]


def version_1_database(path):
    """A results file as written by the first version: text keys and ISO timestamps in every row."""
    db = sqlite3.connect(path)
    db.executescript(VERSION_1)
    db.close()
    return path


def test_values_are_stored_compactly_in_key_order(tmp_path):
    store = ScenarioStore(str(create_dummy_database(tmp_path / "new.sqlite3")))
    db = store.db
    assert "WITHOUT ROWID" in table_sql(db, "analysis_values")
    columns = [r["name"] for r in db.execute("PRAGMA table_info(analysis_values)")]
    assert columns == ["series_id", "t", "value"]  # no text key and no text timestamp per value
    assert db.execute("SELECT typeof(t) FROM analysis_values LIMIT 1").fetchone()[0] == "integer"
    # one series per run, metric and element; its values are one contiguous key range
    series = db.execute("SELECT COUNT(*) FROM analysis_series").fetchone()[0]
    assert series == db.execute("SELECT COUNT(DISTINCT series_id) FROM analysis_values").fetchone()[0]
    store.close()


def test_reading_works_while_the_powerfactory_script_writes(tmp_path, monkeypatch):
    """Every API request opens a store; it must not wait for the write lock a saving scenario holds."""
    import app.simulation.store as store_module

    path = create_dummy_database(tmp_path / "busy.sqlite3")
    writer = sqlite3.connect(path, isolation_level=None)
    writer.execute("BEGIN IMMEDIATE")  # the script is in the middle of save_scenario
    writer.execute("UPDATE pf_catalog SET updated_at='now'")
    connect = sqlite3.connect
    monkeypatch.setattr(store_module.sqlite3, "connect", lambda *a, **k: connect(*a, **{**k, "timeout": 1}))
    store = ScenarioStore(str(path))
    assert len(store.overview()["scenarios"]) == 8
    store.close()
    writer.execute("ROLLBACK")
    writer.close()


def test_a_locked_database_is_not_reported_as_a_broken_schema_file(tmp_path, monkeypatch):
    from app.analysis import schema

    path = tmp_path / "locked.sqlite3"
    writer = sqlite3.connect(path, isolation_level=None)
    writer.execute("BEGIN EXCLUSIVE")
    with pytest.raises(sqlite3.OperationalError, match="locked"):
        schema.apply(sqlite3.connect(path, timeout=0.1))
    writer.execute("ROLLBACK")
    writer.close()


def test_a_file_of_the_first_version_is_refused_with_what_to_do(tmp_path):
    from app.analysis.bootstrap import select_database
    from app.analysis.repository import AnalysisRepository
    from app.analysis.schema import OutdatedDatabaseError

    path = version_1_database(tmp_path / "old.sqlite3")
    with pytest.raises(OutdatedDatabaseError, match="earlier version.*-DeleteDatabase"):
        ScenarioStore(str(path))
    with pytest.raises(OutdatedDatabaseError, match="earlier version"):
        AnalysisRepository(str(path))
    with pytest.raises(ValueError, match="earlier version"):
        select_database(str(path))
    db = sqlite3.connect(path)  # nothing was added to the old file
    assert db.execute("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'analysis_series%'").fetchone()[0] == 0
    db.close()


def test_views_give_readable_results_for_external_tools(tmp_path):
    path = create_dummy_database(tmp_path / "views.sqlite3")
    store = ScenarioStore(str(path))
    with store.db:
        store.db.execute(
            "UPDATE analysis_elements SET path='\\P.IntPrj\\Network Data.IntPrjfolder\\D7 Grid.ElmNet\\' || name"
        )
    db = store.db
    scenarios = db.execute("SELECT * FROM v_scenarios ORDER BY scenario").fetchall()
    assert len(scenarios) == 8 and scenarios[0]["ref_run_id"] and scenarios[0]["outage_run_id"]
    row = db.execute(
        "SELECT scenario, case_kind, element, element_class, element_type, grid, metric, unit, timestamp_utc, value "
        "FROM v_samples WHERE scenario='Outage Line North' AND element='Line North–East' AND case_kind='OUTAGE' AND metric='loading' "
        "ORDER BY value DESC LIMIT 1"
    ).fetchone()
    assert row["grid"] == "D7 Grid" and row["metric"] == "loading" and row["unit"] == "%"
    assert round(row["value"], 1) == 128.2  # the same peak the dashboard shows
    assert row["timestamp_utc"].startswith("20")  # readable UTC time, e.g. 2026-01-05 13:45:00
    assert db.execute("SELECT DISTINCT grid FROM v_elements").fetchall()[0]["grid"] == "D7 Grid"
    lodf = db.execute("SELECT * FROM v_lodf WHERE scenario='Outage Line North' AND element='Line North–East'").fetchone()
    assert round(lodf["lodf"], 2) == 0.55
    store.close()


def test_views_are_read_only(tmp_path):
    store = ScenarioStore(str(create_dummy_database(tmp_path / "views.sqlite3")))
    with pytest.raises(sqlite3.OperationalError):
        store.db.execute("DELETE FROM v_samples")
    store.close()


def test_the_dashboard_reads_while_powerfactory_is_writing_and_sees_a_scenario_once_it_is_saved(tmp_path, monkeypatch):
    """PowerFactory saves a scenario in one long transaction; the dashboard must answer at once meanwhile."""
    import json
    import time

    from fastapi.testclient import TestClient

    from app.main import app
    from app.simulation import settings

    path = create_dummy_database(tmp_path / "live.sqlite3")
    monkeypatch.setattr(settings, "ANALYSIS_MODE", "sqlite")
    monkeypatch.setattr(settings, "ANALYSIS_DB_PATH", str(path))
    script = sqlite3.connect(path, isolation_level=None)  # the PowerFactory script
    script.execute("BEGIN IMMEDIATE")  # the write lock is held until the scenario is complete
    script.execute("INSERT INTO pf_jobs(id,kind,payload,status,created_at) VALUES('j','run','{}','completed','x')")
    script.execute("INSERT INTO pf_scenarios VALUES('j','New outage','P','SC',?, 'x')", (json.dumps(["o"]),))
    script.execute("INSERT INTO pf_progress VALUES(1,'running','STEP 5/5 · Scenarios','Scenario 9/9 · New outage',9,9,'t0','t1')")
    with TestClient(app) as client:
        started = time.perf_counter()
        overview = client.get("/api/simulation/outage-management").json()
        index = client.get("/api/simulation/across-scenarios/index").json()
        runs = client.get("/api/simulation/facilities").json()
        assert time.perf_counter() - started < 2  # no waiting for the writer
        assert len(overview["scenarios"]) == 8 and len(index["scenarios"]) == 8 and runs  # the saved state, not a half one
        assert overview["progress"] is None  # the progress note is part of the same, still open, transaction
        script.execute("COMMIT")
        overview = client.get("/api/simulation/outage-management").json()
        assert len(overview["scenarios"]) == 9  # now it is there
        assert overview["progress"]["state"] == "running" and overview["progress"]["detail"] == "Scenario 9/9 · New outage"
    script.close()


def test_the_progress_row_is_created_by_the_first_note_and_updated_in_place(tmp_path):
    store = ScenarioStore(str(tmp_path / "p.sqlite3"))
    assert store.progress() is None and store.overview()["progress"] is None
    store.set_progress("running", "STEP 1/5", restart=True)
    first = store.progress()
    store.set_progress("running", "STEP 5/5", "Scenario 1/2 · A", 1, 2)
    second = store.progress()
    assert second["started_at"] == first["started_at"] and second["step"] == "STEP 5/5" and second["current"] == 1
    store.set_progress("running", "STEP 1/5", restart=True)  # a new run
    assert store.progress()["started_at"] >= first["started_at"] and store.progress()["current"] is None
    assert store.db.execute("SELECT COUNT(*) FROM pf_progress").fetchone()[0] == 1
    store.close()
