"""Import reductions must equal the SQL readers, including nulls and inclusive outage windows."""

import pytest

from app.simulation import across, prepared
from app.simulation.store import ScenarioStore


@pytest.mark.parametrize('timestamps', [[0, 900, 1800, 5400, 9000], [100]])
def test_prepared_statistics_equal_sql(tmp_path, monkeypatch, timestamps):
    monkeypatch.setattr(prepared, 'GROUP_VALUES', 2 * len(timestamps))  # cross multiple flush boundaries
    store = ScenarioStore(tmp_path / 'stats.sqlite3')
    db = store.db
    db.execute("INSERT INTO analysis_runs VALUES('r','r','p','s','test','completed')")
    windows = [[], [(900, 5400)], [(0, 900), (900, 1800)], [(99999, 100000)]]
    stats = prepared.RunStats(timestamps, windows)
    clock = prepared.RunTimes(len(timestamps))
    expected = [[None, 0, None, None, 0] for _ in timestamps]
    for metric, category in [('loading', 'line'), ('voltage', 'bus')]:
        db.execute('INSERT INTO analysis_metrics VALUES(?,?,?,?,?,?)', ('r', metric, metric, '', None, None))
        for i in range(7):
            name = f'{metric}{i}'
            lower, upper = (None, 100) if metric == 'loading' else ((None, None) if i == 5 else (0.95, 1.05))
            vals = [None if i == 0 or (i + j) % 4 == 0 else (80 + i * 8 if metric == 'loading' else 0.9 + i * .03)
                    for j in range(len(timestamps))]
            db.execute('INSERT INTO analysis_elements VALUES(?,?,?,?,?,?)', ('r', name, name, '', category, ''))
            if lower is not None or upper is not None:
                db.execute('INSERT INTO pf_element_limits VALUES(?,?,?,?,?)', ('r', name, metric, lower, upper))
            series = db.execute('INSERT INTO analysis_series(run_id,metric_id,element_id) VALUES(?,?,?)',
                                ('r', metric, name)).lastrowid
            db.executemany('INSERT INTO analysis_values VALUES(?,?,?)', [(series, t, v) for t, v in zip(timestamps, vals)])
            stats.add(name, metric, vals, lower, upper)
            clock.add(metric, category, vals, lower, upper)
            for row, value in zip(expected, vals):
                if value is None:
                    continue
                if metric == 'loading':
                    row[0] = value if row[0] is None else max(row[0], value)
                    row[1] += upper is not None and value > upper
                else:
                    row[2] = value if row[2] is None else min(row[2], value)
                    row[3] = value if row[3] is None else max(row[3], value)
                    row[4] += (lower is not None and value < lower) or (upper is not None and value > upper)
    for window in windows:
        assert stats.loading_stats(window, across.DEFAULT_LIMITS) == across._loading_stats(db, 'r', window, across.DEFAULT_LIMITS)
        assert stats.voltage_range(window) == across._voltage_range(db, 'r', window)
    assert stats.hours_outside() == across._hours_outside(db, 'r')
    assert list(zip(*clock.columns())) == [tuple(r) for r in expected]
    assert stats.loading_stats([], [11, 22]) is None
    assert stats.voltage_range([(10, 11)]) is None
    store.close()


def test_empty_metrics_are_prepared_as_empty():
    stats = prepared.RunStats([0, 900], [[]])
    assert stats.loading_stats([], across.DEFAULT_LIMITS) == {}
    assert stats.voltage_range([]) == {}
    assert stats.hours_outside() == {}


def test_bridge_prepares_evaluation_without_reading_values(tmp_path, monkeypatch):
    from tests import large_dataset

    def unexpected(*args, **kwargs):
        pytest.fail('bridge reread raw values for a prepared evaluation')
    for name in ('_loading_stats', '_voltage_range', '_hours_outside'):
        monkeypatch.setattr(across, name, unexpected)
    large_dataset.build(tmp_path / 'import.sqlite3', branches=12, cases=3, contingencies=0, window=24, spacing=48)
