"""One cross-process import owner per database; OS locks are released even after a process crash."""

import os
import re
import socket
import stat
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from app.simulation import values


class ImportBusy(RuntimeError):
    pass


@contextmanager
def serialized(database):
    """Coordinate bridge/future external imports on Windows and Unix. Readers never acquire this lock.

    Keep the lock file: unlinking a locked inode would let another importer lock a new file at the same path.
    Its contents are diagnostic only; the OS byte/file lock, never PID probing or file age, decides ownership.
    """
    path = Path(database).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(str(path) + '.import.lock', 'a+b') as handle:
        if handle.seek(0, os.SEEK_END) == 0:
            handle.write(b' ')
            handle.flush()
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise ImportBusy(f'An import already owns {path}. Retry when it has finished.') from exc
        try:
            handle.seek(1)
            handle.truncate()
            handle.write(f'{os.getpid()} {socket.gethostname()} {datetime.now(timezone.utc).isoformat()}\n'.encode())
            handle.flush()
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def recover(db, database):
    """Called only by the import owner. Preserve every committed run and fail interrupted assessments.

    A retry creates a new assessment from kept native results. It never overwrites an earlier import. Remove
    only generated UUID/hash-named files absent from the committed manifest; leave unrelated files untouched.
    """
    removed = []
    referenced = {r[0] for r in db.execute('SELECT path FROM pf_run_values')}
    kept = referenced | {values.sidecar(p, table) for p in referenced for table in values._METADATA}
    pattern = re.compile(r'^(?:[0-9a-f]{32}|[0-9a-f]{64})(?:\.(?:analysis_series|analysis_elements|pf_element_limits))?\.parquet(?:\.partial)?$')
    for file in values.folder(database).glob('*'):
        if file.is_file() and file.name not in kept and pattern.fullmatch(file.name):
            file.chmod(stat.S_IRUSR | stat.S_IWUSR)
            file.unlink()
            removed.append(file.name)
    with db:
        db.execute("UPDATE gl_evaluations SET payload=? WHERE assessment_id IN "
                   "(SELECT id FROM gl_assessments WHERE status='evaluating') AND json_extract(payload,'$.status')='pending'",
                   ('{"status":"failed","reason":"Original evaluation was interrupted; reimport kept native results."}',))
        db.execute("UPDATE gl_assessments SET status='evaluation_failed' WHERE status='evaluating'")
        db.execute("UPDATE gl_cases SET status='IMPORT FAILED',reason='Previous import was interrupted; reimport kept native results.' "
                   "WHERE assessment_id IN (SELECT id FROM gl_assessments WHERE status='importing') "
                   "AND NOT EXISTS (SELECT 1 FROM gl_results r WHERE r.assessment_id=gl_cases.assessment_id "
                   "AND r.case_id=gl_cases.case_id AND r.kind='QDS' AND r.analysis_run_id IS NOT NULL)")
        changed = db.execute("UPDATE gl_assessments SET status='failed' WHERE status='importing'").rowcount
    return {'assessments': changed, 'removed': removed}
