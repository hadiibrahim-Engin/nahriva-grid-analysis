"""Complete raw access, mixed storage, concurrent readers and file replacement."""

import csv
import io
import json
import os
import sqlite3
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import pytest

from app.analysis.repository import AnalysisRepository
from app.simulation import values
from app.simulation.store import ScenarioStore, LAYOUT_VERSION
from tests.qds_fixture import create_dummy_database
from tests.stored_values import run_values


def parquet_run(db, path, run):
    data = run_values(db, run)
    writer = values.ValueWriter(path, run)
    series = {}
    for sid, t, value in data:
        series.setdefault(sid, []).append((t, value))
    for sid, points in series.items():
        writer.add(sid, [p[0] for p in points], [p[1] for p in points])
    record = writer.close(db)
    with db:
        db.execute('INSERT INTO pf_run_values VALUES(?,?,?,?,?,?)', (run, *record))
        db.execute('DELETE FROM analysis_values WHERE series_id IN (SELECT id FROM analysis_series WHERE run_id=?)', (run,))
    return data


@pytest.mark.parametrize('storage', ['sqlite', 'parquet', 'mixed'])
def test_complete_access_equals_sqlite_view(tmp_path, storage, monkeypatch):
    from tests import qds_fixture
    monkeypatch.setattr(qds_fixture, "STEPS", 12)
    path = create_dummy_database(tmp_path / 'access.sqlite3')
    store = ScenarioStore(path)
    db = store.db
    expected = [dict(r) for r in db.execute('SELECT * FROM v_samples')]
    runs = [r[0] for r in db.execute('SELECT id FROM analysis_runs')]
    for run in runs if storage == 'parquet' else runs[:2] if storage == 'mixed' else []:
        parquet_run(db, path, run)
    sort = lambda rows: sorted(rows, key=lambda r: (r['scenario_id'] or '', r['run_id'], r['element_id'], r['metric'], r['epoch']))
    assert sort(values.iter_samples(db, batch_size=333)) == sort(expected)
    formats = {r[0] for r in db.execute('SELECT storage_format FROM v_run_storage')}
    assert formats == ({'sqlite', 'parquet'} if storage == 'mixed' else {storage})
    scenario = expected[0]['scenario_id']
    t = expected[0]['epoch']
    subset = list(values.iter_samples(db, scenario_id=scenario, start=t, end=t+1, batch_size=2))
    assert sort(subset) == sort(r for r in expected if r['scenario_id'] == scenario and r['epoch'] == t)
    if storage == 'mixed':
        script = Path(__file__).resolve().parents[2] / 'scripts/read_values.py'
        result = subprocess.run([sys.executable, str(script), str(path), '--scenario', scenario, '--start', str(t),
                                 '--end', str(t+1), '--format', 'jsonl'], capture_output=True, text=True, check=True)
        assert sort(json.loads(line) for line in result.stdout.splitlines()) == sort(subset)
        result = subprocess.run([sys.executable, str(script), str(path), '--scenario', scenario, '--start', str(t),
                                 '--end', str(t+1)], capture_output=True, text=True, check=True)
        assert len(list(csv.DictReader(io.StringIO(result.stdout)))) == len(subset)
    store.close()


def test_independent_runs_build_concurrently_on_one_repository(tmp_path, monkeypatch):
    path = create_dummy_database(tmp_path / 'parallel.sqlite3')
    store = ScenarioStore(path)
    runs = [r[0] for r in store.db.execute('SELECT id FROM analysis_runs LIMIT 2')]
    for run in runs:
        parquet_run(store.db, path, run)
    store.close()
    repo = AnalysisRepository(str(path))
    original = values._Engine.__init__
    barrier = Barrier(2, timeout=5)

    def build(self):
        barrier.wait()  # both must reach engine construction without a global/repository lock
        original(self)
    monkeypatch.setattr(values._Engine, '__init__', build)
    with ThreadPoolExecutor(2) as pool:
        assert list(pool.map(repo.sample_count, runs)) == [s[0] for s in repo.db.execute(
            'SELECT rows FROM pf_run_values ORDER BY run_id')]
    repo.close()


def test_replaced_file_does_not_reuse_cached_engine(tmp_path):
    import pyarrow.parquet as pq
    import pyarrow as pa

    path = create_dummy_database(tmp_path / 'replacement.sqlite3')
    store = ScenarioStore(path)
    run = store.db.execute('SELECT id FROM analysis_runs LIMIT 1').fetchone()[0]
    parquet_run(store.db, path, run)
    before = values.query(store.db, run, 'SELECT MAX(value) FROM analysis_values')[0][0]
    file = values.file_of(store.db, path, run)
    table = pq.read_table(file)
    table = table.set_column(2, table.schema.field('value'), pa.array([9999.] * table.num_rows))
    replacement = file.with_suffix('.new')
    pq.write_table(table, replacement)
    os.replace(replacement, file)
    store.db.execute('UPDATE pf_run_values SET sha256=? WHERE run_id=?', (values.checksum(file), run))
    assert values.query(store.db, run, 'SELECT MAX(value) FROM analysis_values')[0][0] == 9999 != before
    store.close()


def test_layout_14_adds_storage_view_without_changing_values(tmp_path):
    path = create_dummy_database(tmp_path / 'upgrade.sqlite3')
    with sqlite3.connect(path) as db:
        before = db.execute('SELECT COUNT(*) FROM analysis_values').fetchone()[0]
        db.execute('DROP VIEW v_run_storage')
        db.execute('PRAGMA user_version=14')
    store = ScenarioStore(path)
    assert store.db.execute('PRAGMA user_version').fetchone()[0] == LAYOUT_VERSION
    assert store.db.execute('SELECT COUNT(*) FROM v_run_storage').fetchone()[0] == 16
    assert store.db.execute('SELECT COUNT(*) FROM analysis_values').fetchone()[0] == before
    store.close()


def test_empty_parquet_run_and_missing_sidecars_are_readable(tmp_path):
    path = tmp_path / 'empty.sqlite3'
    store = ScenarioStore(path)
    with store.db:
        store.db.execute("INSERT INTO analysis_runs VALUES('empty','empty','p','s','test','completed')")
        writer = values.ValueWriter(path, 'empty')
        store.db.execute('INSERT INTO pf_run_values VALUES(?,?,?,?,?,?)', ('empty', *writer.close(store.db)))
    assert list(values.iter_samples(store.db)) == []
    for file in values.folder(path).glob('empty.*.parquet'):
        file.chmod(0o600)
        file.unlink()
    values._ENGINES.clear()
    assert values.query(store.db, 'empty', 'SELECT COUNT(*) FROM analysis_series WHERE run_id=?', ('empty',))[0][0] == 0
    store.close()


def test_layout_15_adds_original_evaluation_storage_without_inventing_verdicts(tmp_path):
    from tests.qds_fixture import create_dummy_database
    path = create_dummy_database(tmp_path / 'layout15.sqlite3')
    with sqlite3.connect(path) as db:
        before = db.execute('SELECT COUNT(*) FROM analysis_values').fetchone()[0]
        db.execute('DROP TABLE gl_evaluations')
        db.execute('PRAGMA user_version=15')
    store = ScenarioStore(path)
    try:
        assert store.db.execute('PRAGMA user_version').fetchone()[0] == LAYOUT_VERSION
        assert store.db.execute('SELECT COUNT(*) FROM gl_evaluations').fetchone()[0] == 0
        assert store.db.execute('SELECT COUNT(*) FROM analysis_values').fetchone()[0] == before
    finally:
        store.close()


@pytest.mark.parametrize("parquet", [False, True])
def test_selected_hour_reads_preserve_null_zero_and_missing_series(tmp_path, parquet):
    path = create_dummy_database(tmp_path / "selected.sqlite3")
    store = ScenarioStore(path)
    try:
        db = store.db
        run, metric, element, series, t = db.execute(
            "SELECT s.run_id,s.metric_id,s.element_id,s.id,v.t FROM analysis_series s "
            "JOIN analysis_values v ON v.series_id=s.id ORDER BY s.id,v.t LIMIT 1").fetchone()
        next_t = db.execute("SELECT MIN(t) FROM analysis_values WHERE series_id=? AND t>?", (series, t)).fetchone()[0]
        with db:
            db.execute("UPDATE analysis_values SET value=NULL WHERE series_id=? AND t=?", (series, t))
            db.execute("UPDATE analysis_values SET value=0 WHERE series_id=? AND t=?", (series, next_t))
        if parquet:
            parquet_run(db, path, run)
        selection = [f"unknown-{i}" for i in range(1000)] + [element]
        assert values.element_values_at(db, run, metric, t, selection) == {element: None}
        assert values.element_values_at(db, run, metric, next_t, selection) == {element: 0}
        assert values.element_values_at(db, run, metric, t - 1, selection) == {}
    finally:
        store.close()


def test_dense_parquet_time_slice_excludes_unrequested_series(tmp_path):
    path = tmp_path / "dense.sqlite3"
    store = ScenarioStore(path)
    try:
        db = store.db
        writer = values.ValueWriter(path, "dense")
        with db:
            db.execute("INSERT INTO analysis_runs VALUES('dense','dense','p','s','test','completed')")
            for sid in range(400):
                writer.add(sid, [0], [None if sid == 1 else float(sid)])
            db.execute("INSERT INTO pf_run_values VALUES(?,?,?,?,?,?)", ("dense", *writer.close()))
        ids = [i for i in range(400) if i % 3 != 2]
        assert values.samples_at(db, "dense", 0, ids) == {i: None if i == 1 else float(i) for i in ids}
        assert values.samples_at(db, "dense", 1, ids) == {}
    finally:
        store.close()
