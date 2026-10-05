"""SQLite contract shared by the web app and the standard-library PF worker."""

import hashlib
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from app.analysis import schema
from app.analysis.series import insert_values

# Raise when the way this module is called by the others changes (arguments, return values). start_assessment.py
# compares it across all modules, so files of different versions are named instead of failing in a confusing way.
INTERFACE_VERSION = 4


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


# Tables of the PowerFactory bridge, next to the analysis tables of app/analysis/migrations.
PF_TABLES = """
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
    -- Where the PowerFactory script is, so the dashboard can say so while no scenario is saved yet.
    CREATE TABLE IF NOT EXISTS pf_progress (
        id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL, step TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
        current INTEGER, total INTEGER, started_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    -- Why a run is not simply "completed": status 'not_converged' or 'incomplete' with the explanation.
    CREATE TABLE IF NOT EXISTS pf_run_notes (
        run_id TEXT PRIMARY KEY REFERENCES analysis_runs(id), status TEXT NOT NULL, note TEXT NOT NULL
    );
    -- Outages whose LODF is not defined (AC load flow without solution, equipment cut off), with the reason.
    CREATE TABLE IF NOT EXISTS pf_lodf_undefined (
        outage_key TEXT PRIMARY KEY, reason TEXT NOT NULL, computed_at TEXT NOT NULL
    );
"""

# The grid (ElmNet) from an element's PowerFactory path: the folder name before ".ElmNet", the same
# value app/simulation/grids.py gives the dashboard ('' without a grid).
_PREFIX = "substr(e.path, 1, instr(e.path, '.ElmNet') - 1)"
GRID_SQL = (
    "CASE WHEN instr(e.path, '.ElmNet') > 0 THEN "
    "replace(" + _PREFIX + ", rtrim(" + _PREFIX + ", replace(" + _PREFIX + ", '\\', '')), '') ELSE '' END"
)

# Read-only views for Excel / Power BI / Python: names instead of hashed identifiers, one row per value.
# They change nothing about how the dashboard reads; see docs/DATABASE.md.
VIEWS = """
    DROP VIEW IF EXISTS v_scenarios;
    CREATE VIEW v_scenarios AS
    SELECT s.id AS scenario_id, s.name AS scenario, s.project, s.study_case, s.created_at,
           s.outages AS outage_ids,
           (SELECT r.run_id FROM pf_scenario_runs r WHERE r.scenario_id = s.id AND r.kind = 'REF') AS ref_run_id,
           (SELECT r.run_id FROM pf_scenario_runs r WHERE r.scenario_id = s.id AND r.kind = 'OUTAGE') AS outage_run_id
    FROM pf_scenarios s;

    DROP VIEW IF EXISTS v_elements;
    CREATE VIEW v_elements AS
    SELECT e.run_id, e.id AS element_id, e.name AS element, e.className AS element_class,
           e.type AS element_type, {grid} AS grid, e.path
    FROM analysis_elements e;

    DROP VIEW IF EXISTS v_series;
    CREATE VIEW v_series AS
    SELECT se.id AS series_id, se.run_id, r.name AS run, se.metric_id AS metric, m.unit,
           e.id AS element_id, e.name AS element, e.className AS element_class, e.type AS element_type,
           {grid} AS grid
    FROM analysis_series se
    JOIN analysis_runs r ON r.id = se.run_id
    JOIN analysis_metrics m ON m.run_id = se.run_id AND m.id = se.metric_id
    JOIN analysis_elements e ON e.run_id = se.run_id AND e.id = se.element_id;

    -- Every calculated run with its state; a run without scenario is a REF saved before its scenarios.
    DROP VIEW IF EXISTS v_runs;
    CREATE VIEW v_runs AS
    SELECT a.id AS run_id, a.name AS run, COALESCE((SELECT MIN(r.kind) FROM pf_scenario_runs r WHERE r.run_id = a.id), 'REF') AS case_kind,
           COALESCE(n.status, a.status) AS status, COALESCE(n.note, '') AS note,
           (SELECT COUNT(*) FROM pf_scenario_runs r WHERE r.run_id = a.id) AS scenarios
    FROM analysis_runs a LEFT JOIN pf_run_notes n ON n.run_id = a.id;

    DROP VIEW IF EXISTS v_samples;
    CREATE VIEW v_samples AS
    SELECT sc.id AS scenario_id, sc.name AS scenario, r.kind AS case_kind, r.run_id,
           e.id AS element_id, e.name AS element, e.className AS element_class, e.type AS element_type,
           {grid} AS grid, m.id AS metric, m.unit,
           datetime(v.t, 'unixepoch') AS timestamp_utc, v.t AS epoch, v.value
    FROM pf_scenarios sc
    JOIN pf_scenario_runs r ON r.scenario_id = sc.id
    JOIN analysis_series se ON se.run_id = r.run_id
    JOIN analysis_values v ON v.series_id = se.id
    JOIN analysis_metrics m ON m.run_id = se.run_id AND m.id = se.metric_id
    JOIN analysis_elements e ON e.run_id = se.run_id AND e.id = se.element_id
    UNION ALL
    SELECT NULL, NULL, 'REF', se.run_id,
           e.id, e.name, e.className, e.type,
           {grid}, m.id, m.unit,
           datetime(v.t, 'unixepoch'), v.t, v.value
    FROM analysis_series se
    JOIN analysis_values v ON v.series_id = se.id
    JOIN analysis_metrics m ON m.run_id = se.run_id AND m.id = se.metric_id
    JOIN analysis_elements e ON e.run_id = se.run_id AND e.id = se.element_id
    WHERE NOT EXISTS (SELECT 1 FROM pf_scenario_runs r WHERE r.run_id = se.run_id);

    DROP VIEW IF EXISTS v_lodf;
    CREATE VIEW v_lodf AS
    SELECT sc.id AS scenario_id, sc.name AS scenario, l.outage_key, e.id AS element_id, e.name AS element,
           e.className AS element_class, {grid} AS grid, l.lodf, l.p_pre, l.p_post, l.computed_at
    FROM pf_scenarios sc
    JOIN pf_scenario_runs r ON r.scenario_id = sc.id AND r.kind = 'OUTAGE'
    JOIN pf_lodf l ON l.outage_key = (
        SELECT group_concat(value, ',') FROM (SELECT value FROM json_each(sc.outages) ORDER BY value))
    JOIN analysis_elements e ON e.run_id = r.run_id AND e.id = l.element_id;

    DROP VIEW IF EXISTS v_lodf_undefined;
    CREATE VIEW v_lodf_undefined AS
    SELECT sc.id AS scenario_id, sc.name AS scenario, u.outage_key, u.reason, u.computed_at
    FROM pf_scenarios sc
    JOIN pf_lodf_undefined u ON u.outage_key = (
        SELECT group_concat(value, ',') FROM (SELECT value FROM json_each(sc.outages) ORDER BY value));

    DROP VIEW IF EXISTS v_planned_outages;
    CREATE VIEW v_planned_outages AS
    SELECT json_extract(o.value, '$.id') AS outage_id, json_extract(o.value, '$.name') AS outage,
           json_extract(o.value, '$.equipment_name') AS equipment,
           datetime(json_extract(o.value, '$.start'), 'unixepoch') AS start_utc,
           datetime(json_extract(o.value, '$.end'), 'unixepoch') AS end_utc,
           json_extract(o.value, '$.in_period') AS in_simulated_period, json_extract(o.value, '$.path') AS path
    FROM pf_catalog c, json_each(c.payload, '$.outages') o;
""".format(grid=GRID_SQL)

# PRAGMA user_version after set-up. Raise it whenever PF_TABLES or VIEWS change, so every existing
# database is brought up to date once when it is next opened.
LAYOUT_VERSION = 6


class ScenarioStore:
    def __init__(self, path):
        Path(path).resolve().parent.mkdir(parents=True, exist_ok=True)
        self.path = str(path)
        # One store per request or per script run; FastAPI may close it from another worker thread.
        self.db = sqlite3.connect(path, timeout=30, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        # WAL with NORMAL sync: a commit is safe against a crashed process; only a power loss can
        # lose the very last commit. Much faster saves of large scenarios.
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("PRAGMA temp_store=MEMORY")
        try:
            schema.check_version(self.db)
        except schema.OutdatedDatabaseError:
            self.db.close()
            raise
        if schema.needs_setup(self.db, LAYOUT_VERSION):
            self._set_up()

    def _set_up(self):
        """Create what is missing; runs once per database file, not on every request."""
        self.db.execute("PRAGMA journal_mode=WAL")
        schema.apply(self.db)
        self.db.executescript(PF_TABLES + VIEWS)
        schema.mark_set_up(self.db, LAYOUT_VERSION)

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

    def set_progress(self, state, step, detail="", current=None, total=None, restart=False):
        """Record where the script is: state 'running' / 'finished' / 'failed' / 'stopped', the step and the scenario.

        `restart` starts a new run (its start time is remembered). Written often and read by the dashboard
        every few seconds; it is a single row, so it costs nothing.
        """
        stamp = now()
        with self.db:
            row = self.db.execute("SELECT started_at FROM pf_progress WHERE id=1").fetchone()
            started = stamp if restart or row is None else row["started_at"]
            self.db.execute(
                "INSERT INTO pf_progress VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
                "state=excluded.state, step=excluded.step, detail=excluded.detail, current=excluded.current, "
                "total=excluded.total, started_at=excluded.started_at, updated_at=excluded.updated_at",
                (state, step, detail, current, total, started, stamp),
            )

    def progress(self):
        row = self.db.execute("SELECT * FROM pf_progress WHERE id=1").fetchone()
        return None if row is None else {k: row[k] for k in row.keys() if k != "id"}

    def save_lodf(self, rows, undefined=None):
        """Replace the stored LODF values of each outage combination in `rows` and `undefined`.

        Each row is (outage_key, element_id, lodf, p_pre, p_post). The values are
        computed once before any simulation and are independent of result runs.
        `undefined` maps an outage_key whose LODF is not defined to the reason; such an outage keeps no
        values, so an earlier calculation can never show next to the reason.
        """
        rows = list(rows)
        undefined = dict(undefined or {})
        stamp = now()
        with self.db:
            for key in {row[0] for row in rows} | set(undefined):
                self.db.execute("DELETE FROM pf_lodf WHERE outage_key=?", (key,))
                self.db.execute("DELETE FROM pf_lodf_undefined WHERE outage_key=?", (key,))
            self.db.executemany(
                "INSERT INTO pf_lodf_undefined VALUES(?,?,?)",
                [(key, reason, stamp) for key, reason in undefined.items()],
            )
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
                raise ValueError("A PowerFactory job is already open.")
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

    def _run_exists(self, run_id):
        return self.db.execute("SELECT 1 FROM analysis_runs WHERE id=?", (run_id,)).fetchone() is not None

    def _write_run(self, run_id, run, catalog, default_name):
        """The rows of one run (inside the caller's transaction). A run that is not 'completed' keeps its explanation."""
        status = run.get("status") or "completed"
        self.db.execute(
            "INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)",
            (run_id, run.get("name") or default_name, catalog["project"], catalog["study_case"],
             run.get("source", "PowerFactory"), status),
        )
        if status != "completed":
            self.db.execute("INSERT INTO pf_run_notes VALUES(?,?,?)", (run_id, status, run.get("note") or ""))
        self.db.executemany(
            "INSERT INTO analysis_elements VALUES(?,?,?,?,?,?)", [(run_id, *element) for element in run["elements"]]
        )
        self.db.executemany(
            "INSERT INTO analysis_metrics VALUES(?,?,?,?,?,?)", [(run_id, *metric) for metric in run["metrics"]]
        )
        insert_values(self.db, run_id, run["samples"])
        self.db.executemany(
            "INSERT INTO pf_element_limits VALUES(?,?,?,?,?)", [(run_id, *limit) for limit in run.get("limits", [])]
        )

    def save_reference(self, catalog, run):
        """Save the reference run at once, before any scenario exists, so that its time series can be looked at.

        Runs that no scenario links to (the reference of an earlier, aborted assessment) are removed first.
        The scenarios later link to this run (`shared` in save_scenario).
        """
        with self.db:
            self.discard_unlinked_runs()
            self._write_run(run["run_id"], run, catalog, run.get("name") or "Reference")

    def discard_unlinked_runs(self):
        """Delete every run that no scenario links to; returns how many (inside the caller's transaction or its own)."""
        ids = [r[0] for r in self.db.execute(
            "SELECT id FROM analysis_runs WHERE id NOT IN (SELECT run_id FROM pf_scenario_runs)")]
        for run_id in ids:
            self.db.execute("DELETE FROM analysis_values WHERE series_id IN (SELECT id FROM analysis_series WHERE run_id=?)", (run_id,))
            for table in ("analysis_series", "pf_element_limits", "analysis_metrics", "analysis_elements", "pf_run_notes"):
                self.db.execute("DELETE FROM " + table + " WHERE run_id=?", (run_id,))
            self.db.execute("DELETE FROM analysis_runs WHERE id=?", (run_id,))
        return len(ids)

    def save_scenario(self, job, catalog, runs):
        """Commit the named scenario and all its result rows together after restoration.

        A run may carry its own `run_id` and `name`; with `shared` it is written only once and every
        further scenario of the batch is linked to it (the reference with all planned outages disabled).
        Samples are (element_id, metric_id, time, value) with time in epoch seconds (or ISO text).
        """
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
                run_id = run.get("run_id") or job["id"] + "-" + run["kind"]
                if not (run.get("shared") and self._run_exists(run_id)):
                    self._write_run(run_id, run, catalog, job["payload"]["name"] + " · " + run["kind"])
                self.db.execute(
                    "INSERT INTO pf_scenario_runs VALUES(?,?,?)",
                    (job["id"], run_id, run["kind"]),
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
                    "SELECT r.run_id,r.kind,a.source,COALESCE(n.status,a.status) AS status,COALESCE(n.note,'') AS note "
                    "FROM pf_scenario_runs r JOIN analysis_runs a ON a.id=r.run_id "
                    "LEFT JOIN pf_run_notes n ON n.run_id=r.run_id WHERE r.scenario_id=?",
                    (row["id"],),
                )
            ]
            scenarios.append(scenario)
        return {"catalog": self.catalog(), "jobs": jobs, "scenarios": scenarios, "progress": self.progress()}
