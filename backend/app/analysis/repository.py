"""SQL access for persisted PowerFactory simulation results."""

import sqlite3
from pathlib import Path
from threading import RLock
from app.analysis import schema
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
        # Refuse a future schema instead of silently treating it as version 1.
        exists = self.db.execute(
            "SELECT name FROM sqlite_master WHERE name='schema_migrations'"
        ).fetchone()
        if exists and self.db.execute(
            "SELECT MAX(version) FROM schema_migrations"
        ).fetchone()[0] not in (None, 1):
            raise RuntimeError("Unsupported analysis schema version")
        schema.apply(self.db)

    def close(self):
        self.db.close()

    def _all(self, query, params=()):
        with self._lock:
            return [dict(r) for r in self.db.execute(query, params).fetchall()]

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
            self.db.executemany(
                "INSERT INTO analysis_samples VALUES (?,?,?,?,?,?)",
                [
                    (
                        r.id,
                        s.element_id,
                        s.metric_id,
                        s.timestamp.isoformat(),
                        s.value,
                        s.status,
                    )
                    for s in bundle.samples
                ],
            )

    def runs(self):
        return self._all("""SELECT r.*, MIN(s.timestamp) start, MAX(s.timestamp) end,
            COUNT(s.timestamp) sample_count FROM analysis_runs r LEFT JOIN analysis_samples s
            ON s.run_id=r.id GROUP BY r.id ORDER BY r.id""")

    def run(self, run_id):
        rows = [r for r in self.runs() if r["id"] == run_id]
        if not rows:
            raise ResourceNotFoundError("Simulation run not found.")
        return rows[0]

    def elements(self, run_id):
        self.run(run_id)
        return self._all(
            "SELECT id,name,className,type,path FROM analysis_elements WHERE run_id=? ORDER BY name,id",
            (run_id,),
        )

    def metrics(self, run_id):
        self.run(run_id)
        return self._all(
            "SELECT id,name,unit,lower,upper FROM analysis_metrics WHERE run_id=? ORDER BY id",
            (run_id,),
        )
