"""Parquet archive of an analysis: complete, identical to the database, immutable and verifiable."""

import json
import sqlite3
import stat

import pytest

from app.archive import parquet
from tests import large_dataset
from tests.stored_values import copy_database, count, run_values

pq = pytest.importorskip("pyarrow.parquet")


@pytest.fixture(scope="module")
def database(tmp_path_factory):
    path = tmp_path_factory.mktemp("archive") / "a.sqlite3"
    outcome = large_dataset.build(path, model=Gaps(12, 2, 4, 24))
    return path, outcome["assessment_id"]


class Gaps(large_dataset.Model):
    """PowerFactory delivers no valid voltage at the first busbar at midnight (NaN, stored as NULL)."""

    def voltage(self, i, t, active=()):
        return float("nan") if i == 0 and t % 86400 == 0 else super().voltage(i, t, active)


@pytest.fixture(scope="module")
def archive(database, tmp_path_factory):
    path, analysis = database
    return parquet.export_analysis(path, analysis, tmp_path_factory.mktemp("out"))


def test_every_value_of_the_analysis_is_archived_as_stored(database, archive):
    path, analysis = database
    db = sqlite3.connect(path)
    manifest = json.loads((archive / "manifest.json").read_text())
    assert manifest["analysis_id"] == analysis and manifest["compression"]["codec"] == "zstd"
    runs = {r[0] for r in db.execute(
        "SELECT run_id FROM pf_scenario_runs WHERE scenario_id IN (SELECT id FROM pf_scenarios WHERE analysis_id=?)",
        (analysis,))}
    value_files = [f for f in manifest["files"] if f["table"] == "analysis_values"]
    missing = 0
    assert {f["run_id"] for f in value_files} == runs
    for entry in value_files:
        stored = run_values(db, entry["run_id"])
        table = pq.read_table(archive / entry["path"]).sort_by([("series_id", "ascending"), ("t", "ascending")])
        assert table.num_rows == entry["rows"] == len(stored) > 0
        assert list(zip(*table.to_pydict().values())) == stored  # same values, a missing one stays None
        missing += sum(1 for row in stored if row[2] is None)
        assert pq.ParquetFile(archive / entry["path"]).metadata.row_group(0).column(0).compression == "ZSTD"
    assert missing > 0
    n1 = next(f for f in manifest["files"] if f["table"] == "gl_values")
    assert n1["rows"] == db.execute("SELECT COUNT(*) FROM gl_values").fetchone()[0] > 0
    assert set(pq.read_table(archive / n1["path"]).column_names) >= {"value", "code", "state"}


def test_an_archive_is_immutable_and_detects_changes(database, archive, tmp_path):
    path, analysis = database
    assert parquet.verify_archive(archive) == []
    files = [p for p in archive.rglob("*") if p.is_file()]
    assert all(not p.stat().st_mode & stat.S_IWUSR for p in files)
    with pytest.raises(parquet.ArchiveError, match="immutable"):
        parquet.export_analysis(path, analysis, archive.parent)
    copy = tmp_path / "copy"
    copy.mkdir()
    for p in files:
        target = copy / p.relative_to(archive)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(p.read_bytes())
    changed = next((copy / "analysis_values").iterdir())
    data = bytearray(changed.read_bytes())
    data[len(data) // 2] ^= 0xFF
    changed.write_bytes(bytes(data))
    (copy / "extra.parquet").write_bytes(b"")
    problems = parquet.verify_archive(copy)
    assert any("checksum" in p for p in problems) and any("not listed" in p for p in problems)
    (copy / "manifest.json").unlink()
    assert parquet.verify_archive(copy) == ["manifest.json is missing (the archive is incomplete)"]


def test_an_unknown_or_importing_analysis_is_refused_and_leaves_nothing(database, tmp_path):
    path, analysis = database
    with pytest.raises(parquet.ArchiveError, match="not in"):
        parquet.export_analysis(path, "nope", tmp_path)
    importing = tmp_path / "importing.sqlite3"
    importing.write_bytes(path.read_bytes())
    with sqlite3.connect(importing) as db:
        db.execute("UPDATE gl_assessments SET status='importing' WHERE id=?", (analysis,))
    with pytest.raises(parquet.ArchiveError, match="still importing"):
        parquet.export_analysis(importing, analysis, tmp_path / "out")
    assert not (tmp_path / "out").exists() or not any((tmp_path / "out").iterdir())


def test_restore_keeps_all_rows_and_analytical_results(database, archive, tmp_path):
    from app.simulation.store import ScenarioStore
    from app.simulation import across
    target = tmp_path / "restored.sqlite3"
    result = parquet.import_analysis(archive, target)
    assert result["analysis_id"] == database[1]
    with sqlite3.connect(database[0]) as original, sqlite3.connect(target) as restored:
        manifest = json.loads((archive / "manifest.json").read_text())
        for table in {f["table"] for f in manifest["files"]} - {"analysis_values"}:
            assert sorted(original.execute(f'SELECT * FROM "{table}"').fetchall(), key=repr) == sorted(
                restored.execute(f'SELECT * FROM "{table}"').fetchall(), key=repr), table
        for (run,) in original.execute("SELECT id FROM analysis_runs"):  # values: Parquet in both databases
            assert run_values(original, run) == run_values(restored, run)
        assert restored.execute("PRAGMA foreign_key_check").fetchall() == []
    original, restored = ScenarioStore(database[0]), ScenarioStore(target)
    try:
        assert across.scenario_index(original, database[1]) == across.scenario_index(restored, database[1])
        scenario = original.db.execute("SELECT id FROM pf_scenarios LIMIT 1").fetchone()[0]
        assert across.scenario_cells(original, scenario) == across.scenario_cells(restored, scenario)
    finally:
        original.close()
        restored.close()
    with pytest.raises(parquet.ArchiveError, match="exists"):
        parquet.import_analysis(archive, target)


@pytest.mark.parametrize("damage", ["empty", "escape", "bad_schema", "incompatible", "missing_run", "broken_reference", "foreign_value", "duplicate_value"])
def test_invalid_archives_leave_no_database(archive, tmp_path, damage):
    import shutil
    copy = tmp_path / "archive"
    shutil.copytree(archive, copy)
    for p in copy.rglob("*"):
        if p.is_file():
            p.chmod(0o600)
    manifest_path = copy / "manifest.json"
    m = json.loads(manifest_path.read_text())
    if damage == "empty":
        m["files"] = []
    elif damage == "escape":
        m["files"][0]["path"] = "../outside.parquet"
    elif damage == "bad_schema":
        m["files"][0]["columns"] = []
    elif damage == "incompatible":
        m["source"]["layout_version"] = 999
    elif damage == "missing_run":
        entry = next(e for e in m["files"] if e["table"] == "analysis_values")
        m["files"].remove(entry)
        (copy / entry["path"]).unlink()
    elif damage in ("foreign_value", "duplicate_value"):
        import pyarrow as pa
        entry = next(e for e in m["files"] if e["table"] == "analysis_values")
        file = copy / entry["path"]
        table = pq.read_table(file)
        if damage == "duplicate_value":
            table = pa.concat_tables([table, table.slice(0, 1)])
        else:
            ids = table["series_id"].to_pylist()
            ids[0] = -123456
            table = table.set_column(0, table.schema.field('series_id'), pa.array(ids, pa.int64()))
        pq.write_table(table, file)
        entry["rows"] = table.num_rows
        entry["bytes"], entry["sha256"] = file.stat().st_size, parquet._sha256(file)
    else:
        import pyarrow as pa
        entry = next(e for e in m["files"] if e["table"] == "pf_scenario_runs")
        file = copy / entry["path"]
        table = pq.read_table(file)
        table = table.set_column(table.schema.get_field_index("run_id"), table.schema.field("run_id"),
                                 pa.array(["missing"] * table.num_rows))
        pq.write_table(table, file)
        entry["bytes"], entry["sha256"] = file.stat().st_size, parquet._sha256(file)
    manifest_path.write_text(json.dumps(m))
    target = tmp_path / "restored.sqlite3"
    with pytest.raises(parquet.ArchiveError):
        parquet.import_analysis(copy, target)
    assert not target.exists()
    from app.simulation.values import folder
    assert not folder(target).exists()
    assert not list(tmp_path.glob(".restore-*"))


def test_api_archive_workflow_and_access(database, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.simulation import settings
    monkeypatch.setattr(settings, "ANALYSIS_DB_PATH", str(database[0]))
    monkeypatch.setattr(settings, "ALLOW_DB_SWITCH", True)
    target = tmp_path / "reopened.sqlite3"
    with TestClient(app) as client:
        before = client.get("/api/simulation/across-scenarios/index").json()
        response = client.post("/api/simulation/archives/export", json={
            "directory": str(tmp_path / "out"), "analysis": database[1],
            "context": {"query": "?grid=North", "limits": {"warning": 75}}})
        assert response.status_code == 200, response.text
        response = client.post("/api/simulation/archives/import", json={
            "archive": response.json()["path"], "database": str(target)})
        assert response.status_code == 200, response.text
        assert response.json()["context"]["limits"]["warning"] == 75
        assert client.get("/api/simulation/across-scenarios/index").json() == before
        monkeypatch.setattr(settings, "ALLOW_DB_SWITCH", False)
        for route, body in [("export", {"directory": str(tmp_path)}),
                            ("import", {"archive": str(tmp_path), "database": str(target)})]:
            assert client.post("/api/simulation/archives/" + route, json=body).status_code == 403


def test_v1_archives_reopen_with_missing_caches_rebuilt(database, archive, tmp_path):
    import shutil
    copy = tmp_path / "v1"
    shutil.copytree(archive, copy)
    manifest_path = copy / "manifest.json"
    manifest_path.chmod(0o600)
    m = json.loads(manifest_path.read_text())
    m["format_version"] = 1
    omitted = {"pf_catalog", "pf_jobs", "pf_scenario_cells", "pf_lodf", "pf_lodf_undefined"}
    for entry in m["files"][:]:
        if entry["table"] in omitted:
            (copy / entry["path"]).unlink()
            m["files"].remove(entry)
    manifest_path.write_text(json.dumps(m))
    result = parquet.import_analysis(copy, tmp_path / "legacy.sqlite3")
    from app.simulation.store import ScenarioStore
    from app.simulation import across
    a, b = ScenarioStore(database[0]), ScenarioStore(result["path"])
    try:
        scenario = a.db.execute("SELECT id FROM pf_scenarios LIMIT 1").fetchone()[0]
        assert across.scenario_cells(a, scenario) == across.scenario_cells(b, scenario)
    finally:
        a.close()
        b.close()


def test_export_uses_a_consistent_snapshot(database, tmp_path):
    source = tmp_path / "source.sqlite3"
    copy_database(database[0], source)
    with sqlite3.connect(source) as db:  # the values are immutable files; the summaries are rows a writer can change
        run, t, value = db.execute("SELECT run_id, t, loading_max FROM pf_run_times WHERE loading_max IS NOT NULL LIMIT 1").fetchone()
    changed = False

    def change_source(_name, _rows):
        nonlocal changed
        if not changed:
            with sqlite3.connect(source) as db:
                db.execute("UPDATE pf_run_times SET loading_max=999 WHERE run_id=? AND t=?", (run, t))
            changed = True
    archive = parquet.export_analysis(source, database[1], tmp_path / "export", on_file=change_source)
    target = tmp_path / "restore.sqlite3"
    parquet.import_analysis(archive, target)
    with sqlite3.connect(target) as db:
        assert db.execute("SELECT loading_max FROM pf_run_times WHERE run_id=? AND t=?", (run, t)).fetchone()[0] == value


def test_native_runs_are_saved_even_without_scenario_links(database, tmp_path):
    source = tmp_path / "unlinked.sqlite3"
    copy_database(database[0], source)
    with sqlite3.connect(source) as db:
        db.execute("DELETE FROM pf_scenario_runs")
        expected = count(db)
    archive = parquet.export_analysis(source, database[1], tmp_path / "archive")
    target = tmp_path / "restore.sqlite3"
    parquet.import_analysis(archive, target)
    with sqlite3.connect(target) as db:
        assert count(db) == expected
        assert db.execute("SELECT COUNT(*) FROM analysis_values").fetchone()[0] == 0


def test_failed_publication_removes_values_folder(database, archive, tmp_path, monkeypatch):
    from app.simulation import values
    import os

    target = tmp_path / 'failed.sqlite3'
    def fail(*args):
        raise OSError('publication failed')
    monkeypatch.setattr(os, 'link', fail)
    with pytest.raises(parquet.ArchiveError, match='publication failed'):
        parquet.import_analysis(archive, target)
    assert not target.exists() and not values.folder(target).exists()
    assert not list(tmp_path.glob('.restore-*'))
