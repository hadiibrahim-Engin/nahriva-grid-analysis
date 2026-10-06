"""SQL access for persisted PowerFactory simulation results."""

import sqlite3
from pathlib import Path
from threading import RLock
from app.analysis import schema
from app.analysis.series import insert_values
from app.analysis.models import RunBundle
from app.core.errors import ResourceNotFoundError


class AnalysisRepository:
    def __init__(self, path: str):
        self._lock = RLock()
        if path != ":memory:":
            Path(path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA busy_timeout=5000")
        # Another schema version is refused, never read with the wrong layout.
        if schema.check_version(self.db) is None:  # only a new file is set up; an existing one is not written
            schema.apply(self.db)

    def close(self):
        self.db.close()

    def _all(self, query, params=()):
        with self._lock:
            return [dict(r) for r in self.db.execute(query, params).fetchall()]

    def tuples(self, query, params=()):
        """Rows as plain tuples: for the large reads of a series, where a dict per row costs more than the query."""
        with self._lock:
            cursor = self.db.cursor()
            cursor.row_factory = None
            try:
                return cursor.execute(query, params).fetchall()
            finally:
                cursor.close()

    def import_bundle(self, bundle: RunBundle):
        """Atomic append-only import: a duplicate run is an error, never an overwrite."""
        with self._lock, self.db:
            r = bundle.run
            self.db.execute(
                "INSERT INTO analysis_runs VALUES (?,?,?,?,?,?)",
                (r.id, r.name, r.project, r.study_case, r.source, r.status),
            )
            self.db.executemany(
                "INSERT INTO analysis_elements VALUES (?,?,?,?,?,?)",
                [
                    (r.id, e.id, e.name, e.className, e.type, e.path)
                    for e in bundle.elements
                ],
            )
            self.db.executemany(
                "INSERT INTO analysis_metrics VALUES (?,?,?,?,?,?)",
                [
                    (r.id, m.id, m.name, m.unit, m.lower, m.upper)
                    for m in bundle.metrics
                ],
            )
            # A failed sample carries no usable value: stored as NULL like any missing value.
            insert_values(
                self.db,
                r.id,
                (
                    (s.element_id, s.metric_id, s.timestamp, None if s.status == "failed" else s.value)
                    for s in bundle.samples
                ),
            )

    def runs(self):
        # No join with the samples: that read every stored value on each call.
        return self._all("SELECT * FROM analysis_runs ORDER BY id")

    def sample_count(self, run_id):
        return self._all(
            "SELECT COUNT(*) n FROM analysis_series se JOIN analysis_values v ON v.series_id=se.id WHERE se.run_id=?",
            (run_id,),
        )[0]["n"]

    def run(self, run_id):
        rows = self._all("SELECT * FROM analysis_runs WHERE id=?", (run_id,))
        if not rows:
            raise ResourceNotFoundError("Simulation run not found.")
        return rows[0]

    def elements(self, run_id):
        self.run(run_id)
        return self._all(
            "SELECT id,name,className,type,path FROM analysis_elements WHERE run_id=? ORDER BY name,id",
            (run_id,),
        )

    def element(self, run_id, element_id):
        """One element of a run, or None; ResourceNotFoundError for an unknown run."""
        self.run(run_id)
        rows = self._all(
            "SELECT id,name,className,type,path FROM analysis_elements WHERE run_id=? AND id=?", (run_id, element_id)
        )
        return rows[0] if rows else None

    def metrics(self, run_id):
        self.run(run_id)
        return self._all(
            "SELECT id,name,unit,lower,upper FROM analysis_metrics WHERE run_id=? ORDER BY id",
            (run_id,),
        )
