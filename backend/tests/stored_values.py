"""Test helpers for raw values, wherever a run keeps them (SQLite or its Parquet file, app/simulation/values.py)."""

import shutil
import sqlite3
from pathlib import Path

from app.simulation import values


def run_values(db, run_id):
    """(series_id, t, value) of one run, ordered by series and time."""
    return [tuple(r) for r in values.query(
        db, run_id, "SELECT v.series_id, v.t, v.value FROM analysis_values v JOIN analysis_series s ON s.id = v.series_id "
        "WHERE s.run_id = ? ORDER BY v.series_id, v.t", (run_id,))]


def count(db):
    """Number of stored values of every run of the file."""
    runs = [r[0] for r in db.execute("SELECT id FROM analysis_runs")]
    return sum(values.query(db, run, "SELECT COUNT(*) FROM analysis_values v JOIN analysis_series s "
                                     "ON s.id = v.series_id WHERE s.run_id = ?", (run,))[0][0] for run in runs)


def copy_database(source, target):
    """A results database is the SQLite file and its value folder: copy both."""
    with sqlite3.connect(source) as a, sqlite3.connect(target) as b:
        a.backup(b)
    if values.folder(source).exists():
        shutil.copytree(values.folder(source), values.folder(Path(target)))
