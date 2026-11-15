"""The raw QDS values of a run: one immutable Parquet file per run, read with DuckDB (decision E2, docs/STORAGE.md).

SQLite keeps everything else (analyses, scenarios, series, elements, limits and the summaries written at import);
`pf_run_values` says which runs have their values in Parquet. Runs imported before keep their values in the SQLite
table `analysis_values` and are read from there, so every reader asks `query()` and gets the same rows either way.

Layout of a run file (`<database>.values/<run id>.parquet`): columns `series_id`, `t` (epoch seconds UTC), `value`
(NULL: no valid value), ZSTD. Row groups hold up to SERIES_PER_GROUP series over one BLOCK_SECONDS block of time,
sorted by series and time, so a query for one series over a year reads one row group per block and a query for every
element at one time reads one block; the min/max statistics of each row group let DuckDB skip the rest.

Writing (the bridge, inside PowerFactory) needs pyarrow; reading (the dashboard) needs duckdb and pyarrow.
"""

import hashlib
import os
import sqlite3
import stat
import threading
from collections import namedtuple
from pathlib import Path

from app.core.cache import TTLCache

SERIES_PER_GROUP = 1000
BLOCK_SECONDS = 7 * 86400
COMPRESSION = "zstd"
SUFFIX = ".values"

TABLE = """
    -- Runs whose raw values live in a Parquet file instead of analysis_values (path relative to <database>.values).
    CREATE TABLE IF NOT EXISTS pf_run_values (
        run_id TEXT PRIMARY KEY REFERENCES analysis_runs(id), format TEXT NOT NULL, path TEXT NOT NULL,
        rows INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL
    );
"""


def folder(database):
    """Folder of the value files of a results database: <name>.values next to it."""
    path = Path(database)
    return path.with_name(path.stem + SUFFIX)


class ParquetUnavailable(RuntimeError):
    """pyarrow cannot be imported in this Python."""


def _arrow():
    try:
        import pyarrow
        import pyarrow.parquet
    except ImportError as error:
        raise ParquetUnavailable(
            "The results need pyarrow (Parquet). Use a Python like backend/.venv (same version, 64-bit) or install "
            "pyarrow into it: " + str(error)) from None
    return pyarrow, pyarrow.parquet


def check_writer():
    """Raise ParquetUnavailable now, before a calculation, when values could not be written."""
    _arrow()


class ValueWriter:
    """Streams the values of one run into its Parquet file while the bridge reads the series of the run.

    Series arrive one after the other in id order; every SERIES_PER_GROUP series are cut into time blocks and written
    as row groups. Nothing is visible before `close()`: the file is written as .partial and renamed, then made
    read-only.
    """

    def __init__(self, database, run_id):
        self.pa, self.pq = _arrow()
        self.base = folder(database)
        self.base.mkdir(parents=True, exist_ok=True)
        self.name = f"{run_id}.parquet"
        self.target = self.base / self.name
        self.partial = self.base / (self.name + ".partial")
        self.schema = self.pa.schema([
            self.pa.field("series_id", self.pa.int64(), nullable=False),
            self.pa.field("t", self.pa.int64(), nullable=False),
            self.pa.field("value", self.pa.float64()),
        ])
        self.writer = self.pq.ParquetWriter(self.partial, self.schema, compression=COMPRESSION, write_statistics=True)
        self.pending = []  # (series_id, values)
        self.rows = 0
        self.run_id = run_id
        self.sidecars = []

    def add(self, series_id, timestamps, values):
        if not self.pending:
            self.stamps = self.pa.array(timestamps, self.pa.int64())
            self.blocks = self._blocks(timestamps)
        self.pending.append((series_id, self.pa.array(values, self.pa.float64())))
        if len(self.pending) >= SERIES_PER_GROUP:
            self._flush()

    @staticmethod
    def _blocks(stamps):
        """(start, count) of every BLOCK_SECONDS block of the run's time axis."""
        blocks, start = [], 0
        while start < len(stamps):
            limit = stamps[start] - stamps[start] % BLOCK_SECONDS + BLOCK_SECONDS
            end = start
            while end < len(stamps) and stamps[end] < limit:
                end += 1
            blocks.append((start, end - start))
            start = end
        return blocks

    def _flush(self):
        if not self.pending:
            return
        pa = self.pa
        for start, count in self.blocks:
            ids = pa.concat_arrays([pa.repeat(pa.scalar(series_id, pa.int64()), count) for series_id, _v in self.pending])
            ts = pa.concat_arrays([self.stamps.slice(start, count)] * len(self.pending))
            vs = pa.concat_arrays([values.slice(start, count) for _id, values in self.pending])
            self.writer.write_table(pa.table([ids, ts, vs], schema=self.schema), row_group_size=len(ids) or 1)
            self.rows += len(ids)
        self.pending = []

    def close(self, db=None):
        """Finish the file; returns the row of pf_run_values (without run_id).

        With `db` (the bridge's connection, inside the run's transaction) the run's series, elements and limits are
        written beside it as well, so a reader loads them straight into DuckDB instead of copying rows from SQLite
        (100,000 elements: 1.6 s less on the first request of a run).
        """
        self._flush()
        self.writer.close()
        if db is not None:
            for table, sql in _METADATA.items():
                cursor = db.execute(sql, (self.run_id,))
                names = [d[0] for d in cursor.description]
                rows = cursor.fetchall()
                columns = list(zip(*rows)) if rows else [[] for _ in names]
                side = self.base / sidecar(self.name, table)
                self.pq.write_table(self.pa.table({n: list(c) for n, c in zip(names, columns)}), side,
                                    compression=COMPRESSION)
                side.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
                self.sidecars.append(side)
        digest = hashlib.sha256()
        with open(self.partial, "rb") as handle:
            while chunk := handle.read(1 << 20):
                digest.update(chunk)
        size = self.partial.stat().st_size
        os.replace(self.partial, self.target)
        self.target.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
        return "parquet", self.name, self.rows, size, digest.hexdigest()

    def abort(self):
        """Remove whatever was written (before or after close): the run is not stored."""
        try:
            self.writer.close()
        except Exception:
            pass
        self.partial.unlink(missing_ok=True)
        for file in [self.target, *self.sidecars]:
            if file.exists():
                file.chmod(stat.S_IRUSR | stat.S_IWUSR)
                file.unlink()


def sidecar(name, table):
    """File of one metadata table of a run beside its value file: <run>.<table>.parquet."""
    return name[:-len(".parquet")] + f".{table}.parquet"


def remove(database, path):
    """Delete the value file of a run and its metadata files (a run that is replaced or deleted)."""
    for name in [path, *(sidecar(path, table) for table in _METADATA)]:
        file = folder(database) / name
        if file.exists():
            file.chmod(stat.S_IRUSR | stat.S_IWUSR)
            file.unlink()


def _row_type(names):
    """A tuple type for one result: rows readable by position and by column name, like sqlite3.Row, at the cost of
    a plain tuple per row (100,000 rows: about 10 ms instead of 60 ms for an object per row)."""
    index = {name: i for i, name in enumerate(names)}

    class Row(namedtuple("Row", [f"c{i}" for i in range(len(names))])):
        __slots__ = ()

        def __getitem__(self, key):
            return tuple.__getitem__(self, index[key] if isinstance(key, str) else key)

        def keys(self):
            return list(index)
    return Row


# One in-memory DuckDB per run file: its series, elements and limits copied from SQLite once (they never change for
# a finished run), the values as a view on the Parquet file. Queries run on cursors, one per call (thread-safe).
_ENGINES = TTLCache(max_entries=32, ttl_seconds=3600)
_LOCK = threading.Lock()
_METADATA = {
    "analysis_series": "SELECT id, run_id, metric_id, element_id FROM analysis_series WHERE run_id = ?",
    "analysis_elements": "SELECT run_id, id, name, className, type, path FROM analysis_elements WHERE run_id = ?",
    "pf_element_limits": "SELECT run_id, element_id, metric_id, lower, upper FROM pf_element_limits WHERE run_id = ?",
}


def _location(db, run_id):
    try:
        row = db.execute("SELECT path FROM pf_run_values WHERE run_id = ?", (run_id,)).fetchone()
    except sqlite3.OperationalError:  # a results file without the PowerFactory tables: values only in SQLite
        return None
    return row[0] if row else None


def _engine(db, database, run_id, path):
    def build():
        import duckdb
        pa, _pq = _arrow()
        con = duckdb.connect()
        file = (folder(database) / path).as_posix().replace("'", "''")
        con.execute(f"CREATE VIEW analysis_values AS SELECT * FROM read_parquet('{file}')")
        for table, sql in _METADATA.items():
            side = folder(database) / sidecar(path, table)
            if side.exists():  # written at import: loaded natively, no rows pass through Python
                name = side.as_posix().replace("'", "''")
                con.execute(f"CREATE TABLE {table} AS SELECT * FROM read_parquet('{name}')")
                continue
            cursor = db.execute(sql, (run_id,))
            names = [d[0] for d in cursor.description]
            rows = cursor.fetchall()
            columns = list(zip(*rows)) if rows else [[] for _ in names]
            arrow = pa.table({name: list(column) for name, column in zip(names, columns)})
            con.register("_load", arrow)
            con.execute(f"CREATE TABLE {table} AS SELECT * FROM _load")
            con.unregister("_load")
        return con
    with _LOCK:
        return _ENGINES.get_or_compute((str(database), run_id, path), build)


def database_of(db):
    """File of an open SQLite connection (its main database)."""
    return next(row[2] for row in db.execute("PRAGMA database_list") if row[1] == "main")


def query(db, run_id, sql, params=()):
    """Run `sql` over the values of one run where they are: SQLite (analysis_values) or the run's Parquet file.

    The SQL may use analysis_values, analysis_series, analysis_elements and pf_element_limits of that run, in the
    dialect both engines share. Rows can be read by position or column name.
    """
    path = _location(db, run_id) if run_id else None
    if path is None:
        return db.execute(sql, params).fetchall()
    cursor = _engine(db, database_of(db), run_id, path).cursor()
    try:
        cursor.execute(sql, list(params))
        return list(map(_row_type([d[0] for d in cursor.description])._make, cursor.fetchall()))
    finally:
        cursor.close()


def file_of(db, database, run_id):
    """Path of the run's value file, or None when its values are in SQLite."""
    path = _location(db, run_id)
    return None if path is None else folder(database) / path
