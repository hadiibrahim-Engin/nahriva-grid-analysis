"""SQLite contract shared by the web app and the standard-library PF worker."""

import hashlib
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path


def now():
    return datetime.now(timezone.utc).isoformat()


def catalog_signature(catalog):
    content = {
        key: catalog[key]
        for key in ("project_path", "study_case_path", "period", "outages")
    }
    content["grid_name_filter"] = catalog.get("grid_name_filter", "")
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()


def outage_key(outage_ids):
    """Stable identity of an outage combination, independent of scenario name or run."""
    return ",".join(sorted(outage_ids))


class ScenarioStore:
    def __init__(self, path):
        Path(path).resolve().parent.mkdir(parents=True, exist_ok=True)
        self.path = str(path)
        # One store per request or per script run; FastAPI may close it from another worker thread.
        self.db = sqlite3.connect(path, timeout=30, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA journal_mode=WAL")
        migration = Path(__file__).parents[1] / "analysis/migrations/001_analysis.sql"
        self.db.executescript(migration.read_text())
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS pf_catalog (
                id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pf_jobs (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
                status TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT,
                finished_at TEXT, message TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS pf_scenarios (
                id TEXT PRIMARY KEY REFERENCES pf_jobs(id), name TEXT NOT NULL,
                project TEXT NOT NULL, study_case TEXT NOT NULL,
                outages TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pf_scenario_runs (
                scenario_id TEXT NOT NULL REFERENCES pf_scenarios(id),
                run_id TEXT NOT NULL REFERENCES analysis_runs(id), kind TEXT NOT NULL,
                PRIMARY KEY(scenario_id, run_id)
            );
            CREATE TABLE IF NOT EXISTS pf_scenario_provenance (
                scenario_id TEXT PRIMARY KEY REFERENCES pf_scenarios(id),
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ui_shares (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pf_element_limits (
                run_id TEXT NOT NULL, element_id TEXT NOT NULL, metric_id TEXT NOT NULL,
                lower REAL, upper REAL, PRIMARY KEY(run_id,element_id,metric_id),
                FOREIGN KEY(run_id,element_id) REFERENCES analysis_elements(run_id,id)
            );
            CREATE TABLE IF NOT EXISTS pf_lodf (
                outage_key TEXT NOT NULL, element_id TEXT NOT NULL,
                lodf REAL NOT NULL, p_pre REAL, p_post REAL, computed_at TEXT NOT NULL,
                PRIMARY KEY(outage_key, element_id)
            );
        """)

    def close(self):
        self.db.close()

    def catalog(self):
        row = self.db.execute("SELECT * FROM pf_catalog WHERE id=1").fetchone()
        return (
            None
            if row is None
            else {**json.loads(row["payload"]), "updated_at": row["updated_at"]}
        )

    def publish_catalog(self, catalog):
        with self.db:
            self.db.execute(
                "INSERT INTO pf_catalog VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at",
                (json.dumps(catalog), now()),
            )

    def save_lodf(self, rows):
        """Replace the stored LODF values of each outage combination in `rows`.

        Each row is (outage_key, element_id, lodf, p_pre, p_post). The values are
        computed once before any simulation and are independent of result runs.
        """
        rows = list(rows)
        stamp = now()
        with self.db:
            for key in {row[0] for row in rows}:
                self.db.execute("DELETE FROM pf_lodf WHERE outage_key=?", (key,))
            self.db.executemany(
                "INSERT INTO pf_lodf VALUES(?,?,?,?,?,?)",
                [(*row, stamp) for row in rows],
            )

    def enqueue(self, kind, payload):
        job_id = uuid.uuid4().hex
        self.db.execute("BEGIN IMMEDIATE")
        try:
            if self.db.execute(
                "SELECT 1 FROM pf_jobs WHERE status IN ('queued','running')"
            ).fetchone():
                raise ValueError("Es ist bereits ein PowerFactory-Auftrag offen.")
            self.db.execute(
                "INSERT INTO pf_jobs(id,kind,payload,status,created_at) VALUES(?,?,?,'queued',?)",
                (job_id, kind, json.dumps(payload), now()),
            )
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise
        return job_id

    def claim(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            # A worker interrupted during native calculation must never rerun a job implicitly.
            if self.db.execute(
                "SELECT 1 FROM pf_jobs WHERE status='running'"
            ).fetchone():
                raise RuntimeError(
                    "A PowerFactory job is already running. An interrupted job requires explicit recovery."
                )
            row = self.db.execute(
                "SELECT * FROM pf_jobs WHERE status='queued' ORDER BY created_at LIMIT 1"
            ).fetchone()
            if row:
                self.db.execute(
                    "UPDATE pf_jobs SET status='running',started_at=? WHERE id=?",
                    (now(), row["id"]),
                )
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise
        return {**dict(row), "payload": json.loads(row["payload"])} if row else None

    def finish(self, job_id, message, failed=False):
        with self.db:
            self.db.execute(
                "UPDATE pf_jobs SET status=?,finished_at=?,message=? WHERE id=?",
                ("failed" if failed else "completed", now(), message, job_id),
            )

    def save_scenario(self, job, catalog, runs):
        """Commit the named scenario and all its result rows together after restoration."""
        with self.db:
            self.db.execute(
                "INSERT INTO pf_scenarios VALUES(?,?,?,?,?,?)",
                (
                    job["id"],
                    job["payload"]["name"],
                    catalog["project"],
                    catalog["study_case"],
                    json.dumps(job["payload"]["outage_ids"]),
                    now(),
                ),
            )
            self.db.execute(
                "INSERT INTO pf_scenario_provenance VALUES(?,?)",
                (job["id"], json.dumps({k: v for k, v in catalog.items() if k not in ("outages", "updated_at")})),
            )
            for run in runs:
                run_id = job["id"] + "-" + run["kind"]
                self.db.execute(
                    "INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)",
                    (
                        run_id,
                        job["payload"]["name"] + " · " + run["kind"],
                        catalog["project"],
                        catalog["study_case"],
                        run.get("source", "PowerFactory"),
                        "completed",
                    ),
                )
                self.db.executemany(
                    "INSERT INTO analysis_elements VALUES(?,?,?,?,?,?)",
                    [(run_id, *element) for element in run["elements"]],
                )
                self.db.executemany(
                    "INSERT INTO analysis_metrics VALUES(?,?,?,?,?,?)",
                    [(run_id, *metric) for metric in run["metrics"]],
                )
                self.db.executemany(
                    "INSERT INTO analysis_samples VALUES(?,?,?,?,?,?)",
                    ((run_id, *sample) for sample in run["samples"]),
                )
                self.db.execute(
                    "INSERT INTO pf_scenario_runs VALUES(?,?,?)",
                    (job["id"], run_id, run["kind"]),
                )
                self.db.executemany(
                    "INSERT INTO pf_element_limits VALUES(?,?,?,?,?)",
                    [(run_id, *limit) for limit in run.get("limits", [])],
                )
            self.db.execute(
                "UPDATE pf_jobs SET status='completed',finished_at=?,message=? WHERE id=?",
                (now(), "Scenario and reference results saved.", job["id"]),
            )

    def overview(self):
        jobs = [
            dict(row)
            for row in self.db.execute(
                "SELECT id,kind,status,created_at,started_at,finished_at,message,json_extract(payload,'$.name') AS name FROM pf_jobs ORDER BY created_at DESC LIMIT 20"
            )
        ]
        scenarios = []
        for row in self.db.execute(
            "SELECT s.*, p.payload AS provenance_json FROM pf_scenarios s "
            "LEFT JOIN pf_scenario_provenance p ON p.scenario_id=s.id ORDER BY s.created_at DESC"
        ):
            scenario = dict(row)
            provenance = scenario.pop("provenance_json")
            scenario["provenance"] = json.loads(provenance) if provenance else None
            scenario["outage_ids"] = json.loads(scenario.pop("outages"))
            scenario["runs"] = [
                dict(r)
                for r in self.db.execute(
                    "SELECT r.run_id,r.kind,a.source FROM pf_scenario_runs r "
                    "JOIN analysis_runs a ON a.id=r.run_id WHERE r.scenario_id=?",
                    (row["id"],),
                )
            ]
            scenarios.append(scenario)
        return {"catalog": self.catalog(), "jobs": jobs, "scenarios": scenarios}
