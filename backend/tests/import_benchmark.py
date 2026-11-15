"""Critical-path benchmark: import through the real bridge, then the dashboard's requests. Development only.

    cd backend
    .venv/bin/python -m tests.import_benchmark --out /tmp/bench --branches 1000 --cases 6 --contingencies 50
    .venv/bin/python -m tests.import_benchmark --queries-only --db /tmp/bench/bench.sqlite3

Part 1 (import, this process) runs tests/large_dataset.py: the main.py runtime with PowerFactory stand-ins, then the
bridge (gridlens_dashboard.import_results). Every phase of the import is timed by wrapping the function that does it;
the clock starts when the bridge is handed the restored results (after the native calculation and the verified
restoration), so "first scenario" is the time a user waits after PowerFactory is done. Reading the ElmRes is timed
separately: the stand-in computes its synthetic values in Python, which says nothing about PowerFactory's
GetColumnValues, so it is reported but excluded from the processing time.

Part 2 (requests, a fresh process) opens the database as the dashboard does and calls the API in process
(FastAPI TestClient: routing, query, JSON, gzip; no socket, no browser rendering). Per request: the first call in
the fresh process, P50 and P95 over the repeats, response size. The operating-system file cache is warm (the file
was just written); a fresh process is not a cold disk, which cannot be produced without administrator rights.
"""

import argparse
import json
import resource
import statistics
import sqlite3
import subprocess
import sys
import time
from collections import defaultdict
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for folder in ('backend', 'powerfactory'):
    if str(ROOT / folder) not in sys.path:
        sys.path.insert(0, str(ROOT / folder))


def peak_mb():
    """Peak resident memory of this process so far (ru_maxrss: bytes on macOS, kilobytes on Linux)."""
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak / 1e6 if sys.platform == 'darwin' else peak / 1e3


class Clock:
    """Time spent per phase (nested phases are counted in their own phase only) and the events of the import."""

    def __init__(self):
        self.totals = defaultdict(float)
        self.calls = defaultdict(int)
        self.events = []
        self.start = None
        self._stack = []

    @contextmanager
    def phase(self, name):
        started = time.perf_counter()
        self._stack.append(0.0)
        try:
            yield
        finally:
            spent = time.perf_counter() - started
            inner = self._stack.pop()
            self.totals[name] += spent - inner
            self.calls[name] += 1
            if self._stack:
                self._stack[-1] += spent

    def wrap(self, owner, attribute, name):
        original = getattr(owner, attribute)

        def timed(*args, **kwargs):
            with self.phase(name):
                return original(*args, **kwargs)
        setattr(owner, attribute, timed)

    def event(self, name, **extra):
        self.events.append({'event': name, 's': round(time.perf_counter() - self.start, 3), 'peak_mb': round(peak_mb()),
                            **extra})


def instrument(clock):
    """Wrap the functions of every import phase; returns nothing, the wrappers stay for this process."""
    import gridlens_dashboard as bridge
    from app.simulation import across, areas, store, values

    clock.wrap(bridge, '_values', 'elmres_read_standin')
    clock.wrap(bridge, '_sweep_cells', 'elmres_read_standin')
    clock.wrap(bridge, '_qds_axis', 'elmres_read_standin')
    clock.wrap(values.ValueWriter, 'add', 'parquet_write')
    clock.wrap(values.ValueWriter, '_flush', 'parquet_write')
    clock.wrap(values.ValueWriter, '_write_sidecars', 'parquet_sidecars')
    clock.wrap(values, 'checksum', 'checksum')
    clock.wrap(bridge.RunTimes, 'add', 'summaries_run_times')
    clock.wrap(bridge.RunTimes, 'store', 'summaries_run_times')
    clock.wrap(areas.AreaTimes, 'add', 'summaries_areas')
    clock.wrap(areas.AreaTimes, 'store', 'summaries_areas')
    if hasattr(bridge, 'ScenarioStats'):  # evaluation summary built while reading (after the change)
        clock.wrap(bridge.ScenarioStats, 'add', 'summaries_scenario_cells')
    clock.wrap(across, 'prepare_cells', 'scenario_cells')
    clock.wrap(bridge, '_read_qds', 'qds_other_python_and_metadata')
    clock.wrap(bridge, '_read_sweep', 'n1_sweep_python_and_cells')
    clock.wrap(bridge, '_save_scenario', 'scenario_rows')

    class TimedConnection(sqlite3.Connection):
        def commit(self):
            with clock.phase('sqlite_commit'):
                return super().commit()

        def __exit__(self, *args):
            with clock.phase('sqlite_commit'):
                return super().__exit__(*args)

    class Sqlite:
        def __getattr__(self, name):
            return getattr(sqlite3, name)

        @staticmethod
        def connect(*args, **kwargs):
            return sqlite3.connect(*args, factory=TimedConnection, **kwargs)
    store.sqlite3 = Sqlite()


def sizes(path):
    path = Path(path)
    folder = path.with_name(path.stem + '.values')
    files = list(folder.glob('*')) if folder.exists() else []
    values = [f for f in files if f.name.endswith('.parquet') and f.name.count('.') == 1]
    return {
        'sqlite_mb': round(sum(p.stat().st_size for p in path.parent.glob(path.name + '*')) / 1e6, 1),
        'values_mb': round(sum(f.stat().st_size for f in values) / 1e6, 1),
        'sidecars_mb': round(sum(f.stat().st_size for f in files if f not in values) / 1e6, 2),
    }


def run_import(args):
    from tests import large_dataset
    import gridlens_dashboard as bridge

    clock = Clock()
    instrument(clock)
    original = bridge.import_results
    first = {}

    def import_results(bundle, path, saved=None):
        clock.start = time.perf_counter()
        clock.event('import_start')

        def on_saved(done, total, detail, scenarios):
            if detail.startswith('QDS') and done == 1:
                clock.event('ref_committed', detail=detail)
            if scenarios == 1 and 'scenario' not in first:
                first['scenario'] = True
                clock.event('first_scenario_committed', detail=detail)
            if detail.startswith('QDS'):
                first['qds'] = time.perf_counter()
            if saved:
                saved(done, total, detail, scenarios)
        result = original(bundle, path, on_saved)
        clock.event('import_complete')
        return result
    bridge.import_results = import_results
    path = Path(args.out) / 'bench.sqlite3'
    if path.exists():
        raise SystemExit(f'{path} exists; choose an empty --out.')
    path.parent.mkdir(parents=True, exist_ok=True)
    large_dataset.build(path, args.branches, args.cases, args.contingencies, args.window, args.spacing)
    clock.events.insert(-1, {'event': 'all_qds_committed', 's': round(first['qds'] - clock.start, 3)})
    total = clock.events[-1]['s']
    standin = clock.totals.pop('elmres_read_standin', 0.0)
    db = sqlite3.connect(path)
    counts = {
        'runs': db.execute('SELECT COUNT(*) FROM analysis_runs').fetchone()[0],
        'series': db.execute('SELECT COUNT(*) FROM analysis_series').fetchone()[0],
        'qds_values': db.execute('SELECT COALESCE(SUM(rows),0) FROM pf_run_values').fetchone()[0]
        + db.execute('SELECT COUNT(*) FROM analysis_values').fetchone()[0],
        'n1_cells': db.execute('SELECT COUNT(*) FROM gl_values').fetchone()[0],
    }
    db.close()
    report = {
        'parameters': vars(args) | {'out': str(args.out)},
        'counts': counts,
        'events': clock.events,
        'import_s': total,
        'elmres_read_standin_s': round(standin, 2),
        'processing_s_excluding_standin': round(total - standin, 2),
        'phases_s': {k: round(v, 3) for k, v in sorted(clock.totals.items(), key=lambda kv: -kv[1])},
        'peak_rss_mb': round(peak_mb()),
        'sizes': sizes(path),
        'database': str(path),
    }
    return report


def timed_requests(database, repeats):
    """In a fresh process: the dashboard's requests on the database (see module doc)."""
    from app.simulation import settings
    settings.ANALYSIS_DB_PATH = str(database)
    settings.ANALYSIS_MODE = 'sqlite'
    from fastapi.testclient import TestClient
    from app.main import app
    from app.simulation.data import component_id

    db = sqlite3.connect(f'file:{Path(database).resolve()}?mode=ro', uri=True)
    scenarios = [r[0] for r in db.execute('SELECT id FROM pf_scenarios ORDER BY rowid')]
    scenario = scenarios[0]
    runs = dict(db.execute('SELECT kind, run_id FROM pf_scenario_runs WHERE scenario_id=?', (scenario,)).fetchall())
    times = [r[0] for r in db.execute('SELECT t FROM pf_run_times WHERE run_id=? ORDER BY t', (runs['OUTAGE'],))]
    branches = [r[0] for r in db.execute("SELECT element_id FROM analysis_series WHERE run_id=? AND metric_id='loading' "
                                         "ORDER BY id", (runs['OUTAGE'],))]
    n_series = db.execute('SELECT COUNT(*) FROM analysis_series WHERE run_id=?', (runs['OUTAGE'],)).fetchone()[0]
    db.close()
    picks = [times[(k * 7919) % len(times)] for k in range(repeats + 1)]
    elements = [branches[(k * 31) % len(branches)] for k in range(repeats + 1)]
    ids = '&'.join('ids=' + s for s in scenarios[:50])
    requests = {
        'analyses': lambda k: '/api/simulation/analyses',
        'scenario_index': lambda k: '/api/simulation/across-scenarios/index',
        'evaluation_all_scenarios': lambda k: '/api/simulation/across-scenarios/cells?' + ids,
        'time_profile_of_scenario': lambda k: f'/api/simulation/scenarios/{scenario}/times',
        'network_at_time_all_elements': lambda k: (f'/api/simulation/scenarios/{scenario}/snapshot?t={picks[k]}'
                                                   f'&limit=100000'),
        'asset_series_year_reduced': lambda k: (
            f'/api/simulation/timeseries/aggregate/{component_id(runs["OUTAGE"], elements[k])}/L?bucket=86400'),
        'asset_series_year_raw': lambda k: (
            f'/api/simulation/timeseries/raw/{component_id(runs["OUTAGE"], elements[k])}/L'),
        'n1_pairs_gantt': lambda k: f'/api/simulation/scenarios/{scenario}/n1-pairs?kind=(n-1)%27',
        'areas': lambda k: f'/api/simulation/scenarios/{scenario}/areas',
        'evaluation_changed_limits': lambda k: (f'/api/simulation/across-scenarios/{scenarios[k % len(scenarios)]}/cells'
                                                f'?over={90 + k}&over=110&over=120'),
    }
    results = {}
    with TestClient(app) as client:
        for name, url in requests.items():
            durations, size, status = [], 0, None
            for k in range(repeats + 1):
                started = time.perf_counter()
                answer = client.get(url(k), headers={'Accept-Encoding': 'gzip'})
                durations.append((time.perf_counter() - started) * 1000)
                size, status = len(answer.content), answer.status_code
            rest = sorted(durations[1:])
            results[name] = {
                'status': status, 'first_ms': round(durations[0], 1), 'p50_ms': round(statistics.median(rest), 1),
                'p95_ms': round(rest[min(len(rest) - 1, int(0.95 * len(rest)))], 1), 'bytes': size,
            }
    return {'series_per_run': n_series, 'times': len(times), 'requests': results, 'peak_rss_mb': round(peak_mb())}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--out', type=Path, help='empty folder for the database and the report')
    parser.add_argument('--db', type=Path, help='with --queries-only: an existing database')
    parser.add_argument('--queries-only', action='store_true')
    parser.add_argument('--branches', type=int, default=1000)
    parser.add_argument('--cases', type=int, default=6)
    parser.add_argument('--contingencies', type=int, default=50)
    parser.add_argument('--window', type=int, default=120)
    parser.add_argument('--spacing', type=int, default=None)
    parser.add_argument('--repeats', type=int, default=20)
    args = parser.parse_args()
    if args.queries_only:
        print(json.dumps(timed_requests(args.db, args.repeats), indent=2))
        return
    report = run_import(args)
    print(json.dumps(report, indent=2), flush=True)
    answer = subprocess.run([sys.executable, '-m', 'tests.import_benchmark', '--queries-only', '--db', report['database'],
                             '--repeats', str(args.repeats)], cwd=ROOT / 'backend', capture_output=True, text=True)
    if answer.returncode:
        raise SystemExit(answer.stderr)
    report['queries'] = json.loads(answer.stdout)
    print(json.dumps(report['queries'], indent=2))
    (args.out / 'report.json').write_text(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
