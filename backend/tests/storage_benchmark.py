"""Storage benchmark: the same raw-result queries on the SQLite working database and on its Parquet archive (DuckDB).

    backend/.venv/bin/python backend/tests/storage_benchmark.py --db x.sqlite3 --archive <archive>/<analysis id>

Each engine runs in its own process (fair memory figures, no shared cache inside Python); the operating-system
file cache is warm for both (clearing it needs administrator rights). Per query: the first call in the fresh
process, P50/P95 over the repeats, CPU time per call and the peak memory of the process. Both engines must return
the same rows, or the benchmark fails. Needs duckdb (`pip install './backend[bench]'`); test tooling, not shipped.
"""

import argparse
import json
import math
import resource
import sqlite3
import statistics
import subprocess
import sys
import time
from pathlib import Path

QUERIES = ("asset_series", "time_point", "window_max", "top_n", "per_time", "n1_column_max")
LABELS = {
    "asset_series": "One asset, whole period (time series)",
    "time_point": "All elements of a run at one time",
    "window_max": "Highest loading per branch in an outage window",
    "top_n": "Top 100 branches by highest loading, whole run",
    "per_time": "Per time: highest loading and branches above limit",
    "n1_column_max": "n-1: worst value and contingency per column",
}


def parameters(database):
    """The run, element, time, window and n-1 result every query uses, chosen from the database."""
    db = sqlite3.connect(f"file:{Path(database).resolve()}?mode=ro", uri=True)
    run = db.execute("SELECT run_id FROM pf_scenario_runs WHERE kind = 'OUTAGE' ORDER BY scenario_id LIMIT 1").fetchone()[0]
    element = db.execute("SELECT element_id FROM analysis_series WHERE run_id = ? AND metric_id = 'loading' "
                         "ORDER BY id LIMIT 1 OFFSET 7", (run,)).fetchone()[0]
    times = [r[0] for r in db.execute("SELECT t FROM pf_run_times WHERE run_id = ? ORDER BY t", (run,))]
    result = db.execute("SELECT result_id, COUNT(*) c FROM gl_values GROUP BY result_id ORDER BY c DESC LIMIT 1").fetchone()
    db.close()
    third = len(times) // 3
    return {"run": run, "element": element, "t": times[len(times) // 2], "window": [times[third], times[2 * third]],
            "result": result[0] if result else None}


class SqliteEngine:
    def __init__(self, database, _archive, _params):
        self.db = sqlite3.connect(f"file:{Path(database).resolve()}?mode=ro", uri=True)
        self.db.execute("PRAGMA temp_store=MEMORY")

    def run(self, name, p):
        db = self.db
        if name == "asset_series":
            series = db.execute("SELECT id FROM analysis_series WHERE run_id=? AND metric_id='loading' AND element_id=?",
                                (p["run"], p["element"])).fetchone()[0]
            return db.execute("SELECT t, value FROM analysis_values WHERE series_id=? ORDER BY t", (series,)).fetchall()
        if name == "time_point":
            return db.execute("SELECT se.element_id, v.value FROM analysis_series se JOIN analysis_values v "
                              "ON v.series_id = se.id AND v.t = ? WHERE se.run_id = ? AND se.metric_id = 'loading' "
                              "ORDER BY se.element_id", (p["t"], p["run"])).fetchall()
        if name in ("window_max", "top_n"):
            window = "AND v.t BETWEEN ? AND ?" if name == "window_max" else ""
            args = (p["run"], *p["window"]) if name == "window_max" else (p["run"],)
            limit = "" if name == "window_max" else "ORDER BY m DESC, se.element_id LIMIT 100"
            rows = db.execute(f"SELECT se.element_id, MAX(v.value) m FROM analysis_series se JOIN analysis_values v "
                              f"ON v.series_id = se.id WHERE se.run_id = ? AND se.metric_id = 'loading' {window} "
                              f"GROUP BY se.element_id {limit}", args).fetchall()
            return sorted(rows) if name == "window_max" else rows
        if name == "per_time":
            return db.execute("SELECT v.t, MAX(v.value), SUM(CASE WHEN v.value > l.upper THEN 1 ELSE 0 END) "
                              "FROM analysis_series se JOIN analysis_values v ON v.series_id = se.id "
                              "LEFT JOIN pf_element_limits l ON l.run_id = se.run_id AND l.element_id = se.element_id "
                              "AND l.metric_id = se.metric_id WHERE se.run_id = ? AND se.metric_id = 'loading' "
                              "GROUP BY v.t ORDER BY v.t", (p["run"],)).fetchall()
        if name == "n1_column_max":
            # SQLite returns the contingency of the row that holds the maximum (bare column with MAX).
            return db.execute("SELECT column_id, MAX(value), contingency_id FROM gl_values WHERE result_id = ? "
                              "AND value IS NOT NULL GROUP BY column_id ORDER BY column_id", (p["result"],)).fetchall()
        raise ValueError(name)


class DuckEngine:
    def __init__(self, _database, archive, params):
        import duckdb
        archive = Path(archive)
        manifest = json.loads((archive / "manifest.json").read_text(encoding="utf-8"))
        self.values = {f["run_id"]: str(archive / f["path"]) for f in manifest["files"] if f.get("run_id")}
        self.db = duckdb.connect()
        for view, file in (("series", "series"), ("limits", "element_limits"), ("n1_values", "n1_values")):
            self.db.execute(f"CREATE VIEW {view} AS SELECT * FROM read_parquet('{archive / file}.parquet')")

    def run(self, name, p):
        db, values = self.db, f"read_parquet('{self.values[p['run']]}')"
        if name == "asset_series":
            series = db.execute("SELECT id FROM series WHERE run_id=? AND metric_id='loading' AND element_id=?",
                                [p["run"], p["element"]]).fetchone()[0]
            return db.execute(f"SELECT t, value FROM {values} WHERE series_id=? ORDER BY t", [series]).fetchall()
        if name == "time_point":
            return db.execute(f"SELECT se.element_id, v.value FROM series se JOIN {values} v ON v.series_id = se.id "
                              "WHERE v.t = ? AND se.run_id = ? AND se.metric_id = 'loading' ORDER BY se.element_id",
                              [p["t"], p["run"]]).fetchall()
        if name in ("window_max", "top_n"):
            window = "AND v.t BETWEEN ? AND ?" if name == "window_max" else ""
            args = [p["run"], *p["window"]] if name == "window_max" else [p["run"]]
            limit = "ORDER BY se.element_id" if name == "window_max" else "ORDER BY m DESC, se.element_id LIMIT 100"
            return db.execute(f"SELECT se.element_id, MAX(v.value) m FROM series se JOIN {values} v ON v.series_id = se.id "
                              f"WHERE se.run_id = ? AND se.metric_id = 'loading' {window} GROUP BY se.element_id {limit}",
                              args).fetchall()
        if name == "per_time":
            return db.execute(f"SELECT v.t, MAX(v.value), SUM(CASE WHEN v.value > l.upper THEN 1 ELSE 0 END) "
                              f"FROM series se JOIN {values} v ON v.series_id = se.id LEFT JOIN limits l "
                              "ON l.run_id = se.run_id AND l.element_id = se.element_id AND l.metric_id = se.metric_id "
                              "WHERE se.run_id = ? AND se.metric_id = 'loading' GROUP BY v.t ORDER BY v.t",
                              [p["run"]]).fetchall()
        if name == "n1_column_max":
            return db.execute("SELECT column_id, MAX(value), arg_max(contingency_id, value) FROM n1_values "
                              "WHERE result_id = ? AND value IS NOT NULL GROUP BY column_id ORDER BY column_id",
                              [p["result"]]).fetchall()
        raise ValueError(name)


ENGINES = {"sqlite": SqliteEngine, "duckdb": DuckEngine}


def _fingerprint(rows):
    """Row count and rounded sums, to check that both engines answer the same."""
    numbers = [v for row in rows for v in row if isinstance(v, (int, float)) and not isinstance(v, bool)]
    return [len(rows), sum(numbers)]


def _same(a, b):
    return a[0] == b[0] and math.isclose(a[1], b[1], rel_tol=1e-9, abs_tol=1e-6)


def measure(engine, database, archive, repeat):
    """Run every query in this process; returns timings, CPU, peak memory and result fingerprints."""
    params = parameters(database)
    started = time.perf_counter()
    instance = ENGINES[engine](database, archive, params)
    out = {"engine": engine, "open_ms": (time.perf_counter() - started) * 1000, "queries": {}}
    for name in QUERIES:
        if name == "n1_column_max" and params["result"] is None:
            continue
        timings, cpu = [], []
        for _ in range(repeat + 1):
            wall, process = time.perf_counter(), time.process_time()
            rows = instance.run(name, params)
            timings.append((time.perf_counter() - wall) * 1000)
            cpu.append((time.process_time() - process) * 1000)
        warm = sorted(timings[1:])
        out["queries"][name] = {
            "first_ms": timings[0], "p50_ms": statistics.median(warm), "p95_ms": warm[int(0.95 * (len(warm) - 1))],
            "cpu_ms": statistics.median(cpu[1:]), "rows": len(rows), "fingerprint": _fingerprint(rows),
        }
    usage = resource.getrusage(resource.RUSAGE_SELF)
    scale = 1 if sys.platform == "darwin" else 1024  # ru_maxrss: bytes on macOS, KiB on Linux
    out["peak_rss_mb"] = usage.ru_maxrss * scale / 1e6
    out["blocks_read"] = usage.ru_inblock
    return out


def _size_mb(path):
    path = Path(path)
    files = [path] if path.is_file() else [p for p in path.rglob("*") if p.is_file()]
    return sum(p.stat().st_size for p in files) / 1e6


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--archive", required=True, type=Path, help="archive folder of the analysis (export_parquet.py)")
    parser.add_argument("--repeat", type=int, default=20)
    parser.add_argument("--engine", choices=sorted(ENGINES), help=argparse.SUPPRESS)  # child process
    parser.add_argument("--json", type=Path, help="also write the raw results as JSON")
    args = parser.parse_args(argv)
    if args.engine:
        print(json.dumps(measure(args.engine, args.db, args.archive, args.repeat)))
        return 0
    results = {}
    for engine in ENGINES:
        child = subprocess.run([sys.executable, __file__, "--db", str(args.db), "--archive", str(args.archive),
                                "--repeat", str(args.repeat), "--engine", engine],
                               capture_output=True, text=True, check=True)
        results[engine] = json.loads(child.stdout.strip().splitlines()[-1])
    mismatches = [name for name in results["sqlite"]["queries"]
                  if not _same(results["sqlite"]["queries"][name]["fingerprint"], results["duckdb"]["queries"][name]["fingerprint"])]
    print(f"Database {args.db.name}: SQLite {_size_mb(args.db):,.0f} MB, Parquet archive {_size_mb(args.archive):,.0f} MB")
    print(f"Open: SQLite {results['sqlite']['open_ms']:.0f} ms, DuckDB {results['duckdb']['open_ms']:.0f} ms; "
          f"peak memory SQLite {results['sqlite']['peak_rss_mb']:.0f} MB, DuckDB {results['duckdb']['peak_rss_mb']:.0f} MB")
    print("| Query | rows | SQLite first / P50 / P95 / CPU (ms) | DuckDB+Parquet first / P50 / P95 / CPU (ms) |")
    print("|---|---|---|---|")
    for name, s in results["sqlite"]["queries"].items():
        d = results["duckdb"]["queries"][name]
        cell = lambda q: f"{q['first_ms']:.1f} / {q['p50_ms']:.1f} / {q['p95_ms']:.1f} / {q['cpu_ms']:.0f}"  # noqa: E731
        print(f"| {LABELS[name]} | {s['rows']:,} | {cell(s)} | {cell(d)} |")
    if args.json:
        args.json.write_text(json.dumps(results, indent=2), encoding="utf-8")
    if mismatches:
        print("RESULTS DIFFER:", ", ".join(mismatches))
        return 1
    print("Both engines returned the same results for every query.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
