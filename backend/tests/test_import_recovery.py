"""Import ownership and recovery preserve committed cases and never remove unrelated files."""

import os
import subprocess
import sys
from pathlib import Path

import pytest

from app.simulation import imports, values
from app.simulation.store import ScenarioStore
from tests import large_dataset


def test_os_lock_is_exclusive_and_released_after_process_exit(tmp_path):
    path = tmp_path / 'results.sqlite3'
    backend = str(Path(__file__).resolve().parents[1])
    code = "from app.simulation.imports import serialized; import sys; ctx=serialized(sys.argv[1]); ctx.__enter__(); print('locked',flush=True); sys.stdin.read()"
    process = subprocess.Popen([sys.executable, '-c', code, str(path)], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, text=True, env={**os.environ, 'PYTHONPATH': backend})
    try:
        assert process.stdout.readline().strip() == 'locked'
        with pytest.raises(imports.ImportBusy):
            with imports.serialized(path):
                pytest.fail('concurrent import entered')
    finally:
        process.kill()  # no context-manager cleanup: the OS releases the lock
        process.wait(timeout=5)
        process.stdin.close()
        process.stdout.close()
    with imports.serialized(path):
        assert Path(str(path) + '.import.lock').exists()


def test_recovery_retains_committed_data_and_retry_appends(tmp_path):
    path = tmp_path / 'results.sqlite3'
    original = large_dataset.build(path, branches=6, cases=2, contingencies=0, window=24, spacing=48)
    store = ScenarioStore(path)
    db = store.db
    kept = {p.name: values.checksum(p) for p in values.folder(path).iterdir()}
    orphan = values.folder(path) / ('a' * 64 + '.parquet')
    orphan.write_bytes(b'failed before commit')
    partial = values.folder(path) / ('b' * 32 + '.parquet.partial')
    partial.write_bytes(b'crashed during writing')
    unrelated = values.folder(path) / 'notes.txt'
    unrelated.write_text('keep')
    with db:
        db.execute("UPDATE gl_assessments SET status='importing'")
        db.execute("INSERT INTO gl_cases VALUES(?, 'pending','pending','READY','','{}')", (original['assessment_id'],))
    with imports.serialized(path):
        outcome = imports.recover(db, path)
        assert outcome['assessments'] == 1 and set(outcome['removed']) == {orphan.name, partial.name}
        assert imports.recover(db, path) == {'assessments': 0, 'removed': []}
    assert unrelated.read_text() == 'keep'
    assert {name: values.checksum(values.folder(path) / name) for name in kept} == kept
    assert db.execute("SELECT status FROM gl_cases WHERE case_id='pending'").fetchone()[0] == 'IMPORT FAILED'
    assert db.execute('SELECT COUNT(*) FROM pf_scenarios').fetchone()[0] == 2
    store.close()
    retry = large_dataset.build(path, branches=6, cases=2, contingencies=0, window=24, spacing=48)
    store = ScenarioStore(path)
    assert retry['assessment_id'] != original['assessment_id']
    assert store.db.execute('SELECT COUNT(*) FROM pf_scenarios').fetchone()[0] == 4
    assert store.db.execute("SELECT status FROM gl_assessments WHERE id=?", (retry['assessment_id'],)).fetchone()[0] == 'complete'
    store.close()
