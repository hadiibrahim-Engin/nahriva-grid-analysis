-- Results schema, version 2 (compact). Applied once per database file by app/analysis/schema.py.
-- A file written by version 1 is not converted: delete it and calculate again (stop-dashboard.cmd -DeleteDatabase).
-- The layout is described in docs/DATABASE.md.
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);

-- One calculation: a REF or OUTAGE run of PowerFactory.
CREATE TABLE IF NOT EXISTS analysis_runs (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, project TEXT NOT NULL,
    study_case TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL
);

-- Equipment and busbars of a run; id is stable across runs of one project (hash of the PF path).
CREATE TABLE IF NOT EXISTS analysis_elements (
    run_id TEXT NOT NULL REFERENCES analysis_runs(id), id TEXT NOT NULL,
    name TEXT NOT NULL, className TEXT, type TEXT NOT NULL, path TEXT,
    PRIMARY KEY (run_id, id)
);

-- Measured quantities of a run (loading in %, voltage in p.u., ...).
CREATE TABLE IF NOT EXISTS analysis_metrics (
    run_id TEXT NOT NULL REFERENCES analysis_runs(id), id TEXT NOT NULL,
    name TEXT NOT NULL, unit TEXT NOT NULL, lower REAL, upper REAL,
    PRIMARY KEY (run_id, id)
);

-- One time series: run x metric x element. Small; gives every series a short integer key.
CREATE TABLE IF NOT EXISTS analysis_series (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL, metric_id TEXT NOT NULL, element_id TEXT NOT NULL,
    UNIQUE (run_id, metric_id, element_id),
    FOREIGN KEY (run_id, element_id) REFERENCES analysis_elements(run_id, id),
    FOREIGN KEY (run_id, metric_id) REFERENCES analysis_metrics(run_id, id)
);
CREATE INDEX IF NOT EXISTS analysis_series_element ON analysis_series(run_id, element_id);

-- Every value, stored in key order (WITHOUT ROWID): a series is one contiguous range on disk.
-- t: epoch seconds UTC. value NULL: no valid value at that time (e.g. a de-energised busbar).
CREATE TABLE IF NOT EXISTS analysis_values (
    series_id INTEGER NOT NULL REFERENCES analysis_series(id),
    t INTEGER NOT NULL,
    value REAL,
    PRIMARY KEY (series_id, t)
) WITHOUT ROWID;

INSERT OR IGNORE INTO schema_migrations(version) VALUES (2);
