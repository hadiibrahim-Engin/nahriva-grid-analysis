CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS analysis_runs (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, project TEXT NOT NULL,
    study_case TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS analysis_elements (
    run_id TEXT NOT NULL REFERENCES analysis_runs(id), id TEXT NOT NULL,
    name TEXT NOT NULL, className TEXT, type TEXT NOT NULL, path TEXT,
    PRIMARY KEY (run_id, id)
);
CREATE TABLE IF NOT EXISTS analysis_metrics (
    run_id TEXT NOT NULL REFERENCES analysis_runs(id), id TEXT NOT NULL,
    name TEXT NOT NULL, unit TEXT NOT NULL, lower REAL, upper REAL,
    PRIMARY KEY (run_id, id)
);
CREATE TABLE IF NOT EXISTS analysis_samples (
    run_id TEXT NOT NULL, element_id TEXT NOT NULL, metric_id TEXT NOT NULL,
    timestamp TEXT NOT NULL, value REAL, status TEXT NOT NULL,
    PRIMARY KEY (run_id, metric_id, element_id, timestamp),
    FOREIGN KEY (run_id, element_id) REFERENCES analysis_elements(run_id, id),
    FOREIGN KEY (run_id, metric_id) REFERENCES analysis_metrics(run_id, id)
);
CREATE INDEX IF NOT EXISTS analysis_samples_window ON analysis_samples(run_id, metric_id, timestamp);
INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
