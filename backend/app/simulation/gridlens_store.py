"""Raw GridLens results for interactive widgets; no engineering assessment."""

import json

from app.simulation import values
from app.simulation.grids import grid_name
from app.simulation.states import INVALID_OR_MISSING

# Version of the result contract written by the bridge (gl_assessments.result_schema_version). 1: imports made
# before analyses, master data and import status were recorded; 2: with them.
RESULT_SCHEMA_VERSION = 2

TABLES = """
-- One analysis: one import of one PowerFactory run. status: importing, complete or failed ('unknown' for an import
-- made before the status was recorded). calculation_types: JSON list of the result kinds (QDS, n-1, (n-1)').
CREATE TABLE IF NOT EXISTS gl_assessments (
    id TEXT PRIMARY KEY, native_run_id TEXT NOT NULL, project TEXT NOT NULL,
    study_case TEXT NOT NULL, engine_version TEXT NOT NULL, created_at TEXT NOT NULL,
    settings TEXT NOT NULL, configuration TEXT NOT NULL, mode TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unknown', source_system TEXT NOT NULL DEFAULT 'PowerFactory',
    calculation_types TEXT NOT NULL DEFAULT '[]', project_path TEXT NOT NULL DEFAULT '',
    study_case_path TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '',
    period_start INTEGER, period_end INTEGER, result_schema_version INTEGER NOT NULL DEFAULT 1
);
-- Master data of every monitored element of an analysis. element_id is the internal key (SHA-256 of
-- "<project path>|<element path>"); mrid stays NULL until a verified source supplies the CGMES mRID.
CREATE TABLE IF NOT EXISTS gl_elements (
    assessment_id TEXT NOT NULL REFERENCES gl_assessments(id), element_id TEXT NOT NULL,
    name TEXT NOT NULL, class_name TEXT NOT NULL, path TEXT NOT NULL, grid TEXT NOT NULL,
    nominal_kv REAL, mrid TEXT,
    PRIMARY KEY(assessment_id, element_id)
);
-- The grids (areas) at the two ends of a branch: first terminal (bus1/bushv) and second (bus2/buslv). A branch
-- whose ends lie in two grids connects them; its active power is the flow between the areas (app/simulation/areas.py).
CREATE TABLE IF NOT EXISTS gl_branch_ends (
    assessment_id TEXT NOT NULL REFERENCES gl_assessments(id), element_id TEXT NOT NULL,
    from_grid TEXT, to_grid TEXT, PRIMARY KEY(assessment_id, element_id)
);
CREATE TABLE IF NOT EXISTS gl_cases (
    assessment_id TEXT NOT NULL REFERENCES gl_assessments(id), case_id TEXT NOT NULL,
    name TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, definition TEXT NOT NULL,
    PRIMARY KEY(assessment_id, case_id)
);
CREATE TABLE IF NOT EXISTS gl_results (
    id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES gl_assessments(id),
    case_id TEXT NOT NULL, kind TEXT NOT NULL, native_name TEXT NOT NULL, native_path TEXT NOT NULL,
    status TEXT NOT NULL, reason TEXT NOT NULL, metadata TEXT NOT NULL, analysis_run_id TEXT
);
CREATE INDEX IF NOT EXISTS gl_results_assessment ON gl_results(assessment_id, case_id, kind);
CREATE TABLE IF NOT EXISTS gl_columns (
    result_id TEXT NOT NULL REFERENCES gl_results(id), column_id INTEGER NOT NULL,
    element_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, class_name TEXT NOT NULL,
    variable TEXT NOT NULL, metric TEXT NOT NULL, unit TEXT NOT NULL,
    PRIMARY KEY(result_id, column_id)
);
CREATE TABLE IF NOT EXISTS gl_contingencies (
    result_id TEXT NOT NULL REFERENCES gl_results(id), id TEXT NOT NULL,
    name TEXT NOT NULL, path TEXT NOT NULL, equipment TEXT NOT NULL,
    PRIMARY KEY(result_id, id)
);
CREATE TABLE IF NOT EXISTS gl_times (
    result_id TEXT NOT NULL REFERENCES gl_results(id), t INTEGER NOT NULL,
    PRIMARY KEY(result_id, t)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS gl_time_columns (
    result_id TEXT NOT NULL, t INTEGER NOT NULL, column_id INTEGER NOT NULL,
    PRIMARY KEY(result_id, t, column_id),
    FOREIGN KEY(result_id, column_id) REFERENCES gl_columns(result_id, column_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS gl_pairs (
    result_id TEXT NOT NULL, t INTEGER NOT NULL, contingency_id TEXT NOT NULL,
    PRIMARY KEY(result_id, contingency_id, t),
    FOREIGN KEY(result_id, contingency_id) REFERENCES gl_contingencies(result_id, id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS gl_values (
    result_id TEXT NOT NULL, t INTEGER NOT NULL, contingency_id TEXT NOT NULL,
    column_id INTEGER NOT NULL, value REAL, code INTEGER, state TEXT NOT NULL,
    PRIMARY KEY(result_id, contingency_id, column_id, t),
    FOREIGN KEY(result_id, column_id) REFERENCES gl_columns(result_id, column_id)
) WITHOUT ROWID;
-- n-1 summaries written while a sweep is imported, so that the dashboard never scans the raw cells.
-- Per monitored column and study time: the lowest and highest value over every contingency, the contingency that
-- gave it, and how many contingencies violate the limits of the run's settings (lower / upper of gl_n1_columns).
CREATE TABLE IF NOT EXISTS gl_n1_hourly (
    result_id TEXT NOT NULL, column_id INTEGER NOT NULL, t INTEGER NOT NULL,
    low REAL, low_contingency TEXT, high REAL, high_contingency TEXT, violations INTEGER NOT NULL,
    PRIMARY KEY(result_id, column_id, t)
) WITHOUT ROWID;
-- Per monitored column over the whole sweep: extremes, limits used, study times with a violation.
-- severity: how far the worst value lies beyond its limit (negative: inside), for ranking.
CREATE TABLE IF NOT EXISTS gl_n1_columns (
    result_id TEXT NOT NULL, column_id INTEGER NOT NULL, metric TEXT NOT NULL,
    low REAL, low_t INTEGER, low_contingency TEXT, high REAL, high_t INTEGER, high_contingency TEXT,
    lower REAL, upper REAL, severity REAL, violation_times INTEGER NOT NULL, violations INTEGER NOT NULL,
    PRIMARY KEY(result_id, column_id)
);
"""


def decode_row(row, fields=()):
    if row is None:
        return None
    result = dict(row)
    for field in fields:
        result[field] = json.loads(result[field])
    return result


def assessments(db):
    return [decode_row(row, ('settings', 'configuration')) for row in db.execute(
        'SELECT * FROM gl_assessments ORDER BY created_at DESC, id DESC')]


def assessment(db, identifier):
    result = decode_row(db.execute('SELECT * FROM gl_assessments WHERE id=?', (identifier,)).fetchone(),
                        ('settings', 'configuration'))
    if result is not None:
        result['cases'] = [decode_row(row, ('definition',)) for row in db.execute(
            'SELECT * FROM gl_cases WHERE assessment_id=? ORDER BY rowid', (identifier,))]
        result['results'] = [decode_row(row, ('metadata',)) for row in db.execute(
            'SELECT * FROM gl_results WHERE assessment_id=? ORDER BY rowid', (identifier,))]
    return result


def result(db, identifier):
    return decode_row(db.execute('SELECT * FROM gl_results WHERE id=?', (identifier,)).fetchone(), ('metadata',))


def columns(db, identifier):
    return [dict(row) for row in db.execute(
        'SELECT * FROM gl_columns WHERE result_id=? ORDER BY column_id', (identifier,))]


def contingencies(db, identifier, offset=0, limit=100):
    return [decode_row(row, ('equipment',)) for row in db.execute(
        'SELECT * FROM gl_contingencies WHERE result_id=? ORDER BY name,id LIMIT ? OFFSET ?',
        (identifier, limit, offset))]


def times(db, identifier, offset=0, limit=1000):
    return [row[0] for row in db.execute(
        'SELECT t FROM gl_times WHERE result_id=? ORDER BY t LIMIT ? OFFSET ?', (identifier, limit, offset))]


def series(db, identifier, column, contingency, start=None, end=None, limit=1000, offset=0):
    """Raw sparse cells, preserving code 3 and missing time/row/column separately.

    Code 3 is implicit only when both a native row and a native column exist
    at this study time. It is never converted into a measured zero or OK.
    """
    native = result(db, identifier)
    if native['kind'] == 'QDS':
        return qds_series(db, native, column, start, end, limit, offset)
    condition, params = '', [identifier]
    if start is not None:
        condition += ' AND tm.t>=?'
        params.append(start)
    if end is not None:
        condition += ' AND tm.t<?'
        params.append(end)
    rows = db.execute(
        'SELECT tm.t, p.t AS pair_time, c.t AS column_time, v.value, v.code, v.state '
        'FROM gl_times tm '
        'LEFT JOIN gl_pairs p ON p.result_id=tm.result_id AND p.t=tm.t AND p.contingency_id=? '
        'LEFT JOIN gl_time_columns c ON c.result_id=tm.result_id AND c.t=tm.t AND c.column_id=? '
        'LEFT JOIN gl_values v ON v.result_id=tm.result_id AND v.t=tm.t '
        'AND v.contingency_id=? AND v.column_id=? '
        'WHERE tm.result_id=?' + condition + ' ORDER BY tm.t LIMIT ? OFFSET ?',
        (contingency, column, contingency, column, *params, limit, offset))
    found = []
    for row in rows:
        if row['pair_time'] is None:
            state, code = 'missing_row', None
        elif row['column_time'] is None:
            state, code = 'missing_column', None
        elif row['state'] is not None:
            state, code = row['state'], row['code']
        else:
            state, code = 'not_recorded', 3
        found.append({'timestamp': row['t'], 'value': row['value'], 'code': code, 'state': state})
    return found


def qds_series(db, native, column, start, end, limit, offset):
    condition, params = '', [native['id']]
    if start is not None:
        condition += ' AND tm.t>=?'
        params.append(start)
    if end is not None:
        condition += ' AND tm.t<?'
        params.append(end)
    rows = db.execute(
        'SELECT tm.t,s.id series,q.state,q.code FROM gl_times tm '
        'JOIN gl_columns c ON c.result_id=tm.result_id AND c.column_id=? '
        'LEFT JOIN analysis_series s ON s.run_id=? AND s.element_id=c.element_id AND s.metric_id=c.metric '
        "LEFT JOIN gl_values q ON q.result_id=tm.result_id AND q.t=tm.t AND q.column_id=c.column_id AND q.contingency_id='' "
        'WHERE tm.result_id=?' + condition + ' ORDER BY tm.t LIMIT ? OFFSET ?',
        (column, native['analysis_run_id'], *params, limit, offset)).fetchall()
    # The values of the page, from wherever the run keeps them (SQLite or its Parquet file).
    series = rows[0]['series'] if rows else None
    stored = {} if series is None else {r[0]: r[1] for r in values.query(
        db, native['analysis_run_id'],
        'SELECT t, value FROM analysis_values WHERE series_id=? AND t>=? AND t<=?', (series, rows[0]['t'], rows[-1]['t']))}
    return [{'timestamp': row['t'], 'value': stored.get(row['t']),
             'state': row['state'] or ('value' if stored.get(row['t']) is not None else INVALID_OR_MISSING),
             'code': row['code']} for row in rows]


def _names(db, table, identifier, ids):
    """{id: row} of the given ids only: a sweep can have thousands of contingencies, a view names a few."""
    ids = list(ids)
    found = {}
    for start in range(0, len(ids), 500):
        part = ids[start:start + 500]
        key = 'column_id' if table == 'gl_columns' else 'id'
        for row in db.execute('SELECT * FROM {} WHERE result_id=? AND {} IN ({})'.format(table, key, ','.join('?' * len(part))),
                              (identifier, *part)):
            found[row[key]] = row
    return found


def n1_gantt(db, identifier, limit):
    """Overload episodes of an n-1 sweep per branch, for a Gantt chart; reads the import summaries by key only.

    An episode is a run of consecutive study times in which the loading after the worst contingency exceeds the
    limit of the run's settings and the same contingency triggers it. Each episode gives the loading before the
    contingency (the QDS of the same case at that time: the planning case for (n-1)', REF for n-1), the loading
    after it, and for (n-1)' the n-1 loading of the same branch without the planned outages.
    """
    native = result(db, identifier)
    times = [row[0] for row in db.execute('SELECT t FROM gl_times WHERE result_id=? ORDER BY t', (identifier,))]
    step = min((b - a for a, b in zip(times, times[1:])), default=3600)
    prime = native['kind'] == "(n-1)'"
    row = db.execute("SELECT analysis_run_id FROM gl_results WHERE assessment_id=? AND case_id=? AND kind='QDS' "
                     'AND analysis_run_id IS NOT NULL', (native['assessment_id'], native['case_id'] if prime else 'REF')).fetchone()
    pre_run = row[0] if row else None
    row = db.execute("SELECT id FROM gl_results WHERE assessment_id=? AND case_id=? AND kind='n-1'",
                     (native['assessment_id'], native['case_id'])).fetchone() if prime else None
    reference = row[0] if row else None
    lines, contingencies = [], set()
    for column in db.execute(
            'SELECT k.column_id, k.upper, k.high, k.violation_times, c.element_id, c.name, c.path, c.class_name '
            'FROM gl_n1_columns k JOIN gl_columns c ON c.result_id=k.result_id AND c.column_id=k.column_id '
            "WHERE k.result_id=? AND k.metric='loading' AND k.violation_times>0 "
            'ORDER BY k.severity DESC, k.violation_times DESC LIMIT ?', (identifier, limit)).fetchall():
        hours = db.execute('SELECT t, high, high_contingency, violations FROM gl_n1_hourly '
                           'WHERE result_id=? AND column_id=? AND violations>0 ORDER BY t',
                           (identifier, column['column_id'])).fetchall()
        first, last = hours[0]['t'], hours[-1]['t']
        pre = {}
        if pre_run is not None:
            pre = {row[0]: row[1] for row in values.query(
                db, pre_run,
                "SELECT v.t, v.value FROM analysis_series s JOIN analysis_values v ON v.series_id=s.id "
                "WHERE s.run_id=? AND s.element_id=? AND s.metric_id='loading' AND v.t BETWEEN ? AND ?",
                (pre_run, column['element_id'], first, last))}
        before = {}
        if reference is not None:
            before = dict(db.execute(
                "SELECT h.t, h.high FROM gl_columns c JOIN gl_n1_hourly h ON h.result_id=c.result_id AND h.column_id=c.column_id "
                "WHERE c.result_id=? AND c.element_id=? AND c.metric='loading' AND h.t BETWEEN ? AND ?",
                (reference, column['element_id'], first, last)).fetchall())
        segments, current = [], None
        for hour in hours:
            if current is None or hour['t'] != current['end'] or hour['high_contingency'] != current['contingency']:
                current = {'start': hour['t'], 'end': hour['t'], 'contingency': hour['high_contingency'],
                           'post': None, 'peak_t': None, 'pre': None, 'pre_max': None, 'reference': None, 'violations': 0}
                segments.append(current)
            current['end'] = hour['t'] + step
            current['violations'] = max(current['violations'], hour['violations'])
            value = pre.get(hour['t'])
            if value is not None and (current['pre_max'] is None or value > current['pre_max']):
                current['pre_max'] = value
            if current['post'] is None or hour['high'] > current['post']:
                current.update(post=hour['high'], peak_t=hour['t'], pre=value, reference=before.get(hour['t']))
        contingencies.update(segment['contingency'] for segment in segments)
        lines.append({'name': column['name'], 'path': column['path'], 'class_name': column['class_name'],
                      'limit': column['upper'], 'peak': column['high'], 'hours': column['violation_times'],
                      'segments': segments})
    contingencies.discard(None)
    return {
        'result_id': identifier, 'kind': native['kind'], 'case_id': native['case_id'], 'step': step,
        'start': times[0] if times else None, 'end': times[-1] + step if times else None,
        'pre_source': (native['case_id'] if prime else 'REF') if pre_run else None, 'has_reference': reference is not None,
        'lines': lines,
        'contingencies': {key: row['name'] for key, row in _names(db, 'gl_contingencies', identifier, contingencies).items()},
    }


N1_KINDS = ("(n-1)'", 'n-1')


def n1_pairs(db, scenario_id, kind="(n-1)'", start=None, end=None, limit=100):
    """Which contingency overloads which branch, and how strongly: per pair the highest loading after the
    contingency, the loading before it at that time, and the hours above the branch's limit, worst first.

    `kind` "(n-1)'" is the sweep with the scenario's planned outages, "n-1" the one without (before: the QDS of the
    planning case, or REF). Reads the recorded n-1 cells (above the recording limit) and one value per pair from
    the QDS. None when the scenario has no such sweep.
    """
    assessment, _sep, case = scenario_id.rpartition('-')
    native = db.execute('SELECT id FROM gl_results WHERE assessment_id=? AND case_id=? AND kind=?',
                        (assessment, case, kind)).fetchone()
    if native is None:
        return None
    identifier = native[0]
    stamps = [r[0] for r in db.execute('SELECT t FROM gl_times WHERE result_id=? ORDER BY t', (identifier,))]
    step = min((b - a for a, b in zip(stamps, stamps[1:])), default=3600) / 3600
    window, params = '', [identifier]
    if start is not None:
        window += ' AND v.t>=?'
        params.append(start)
    if end is not None:
        window += ' AND v.t<=?'
        params.append(end)
    # SQLite returns t of the row that holds the maximum (bare column next to MAX).
    found = db.execute(
        'SELECT v.contingency_id, v.column_id, MAX(v.value) post, v.t, '
        'SUM(CASE WHEN v.value > COALESCE(k.upper, 100) THEN 1 ELSE 0 END) over_n, k.upper '
        'FROM gl_values v JOIN gl_n1_columns k ON k.result_id=v.result_id AND k.column_id=v.column_id '
        "WHERE v.result_id=? AND k.metric='loading' AND v.contingency_id<>'' AND v.value IS NOT NULL" + window +
        ' GROUP BY v.contingency_id, v.column_id HAVING over_n > 0', params).fetchall()
    found.sort(key=lambda r: (-r[2], -r[4]))
    shown = found[:limit]
    names = dict(db.execute('SELECT id, name FROM gl_contingencies WHERE result_id=?', (identifier,)).fetchall())
    columns = {r[0]: r[1:] for r in db.execute(
        'SELECT c.column_id, c.element_id, c.name, c.path FROM gl_columns c WHERE c.result_id=?', (identifier,))}
    prime = kind == "(n-1)'"
    pre = db.execute("SELECT analysis_run_id FROM gl_results WHERE assessment_id=? AND case_id=? AND kind='QDS' "
                     'AND analysis_run_id IS NOT NULL', (assessment, case if prime else 'REF')).fetchone()
    before = {}
    if pre is not None and shown:
        elements = sorted({columns[r[1]][0] for r in shown})
        times = sorted({r[3] for r in shown})
        before = {(row[0], row[1]): row[2] for row in values.query(
            db, pre[0],
            'SELECT se.element_id, v.t, v.value FROM analysis_series se JOIN analysis_values v ON v.series_id=se.id '
            "WHERE se.run_id=? AND se.metric_id='loading' AND se.element_id IN ({}) AND v.t IN ({})".format(
                ','.join('?' * len(elements)), ','.join('?' * len(times))),
            (pre[0], *elements, *times))}
    pairs = []
    for contingency, column, post, t, over, upper in shown:
        element_id, name, path = columns[column]
        pairs.append({
            'contingency': names.get(contingency, contingency), 'element_id': element_id, 'element': name,
            'grid': grid_name(path), 'post': post, 't': t, 'pre': before.get((element_id, t)),
            'limit': upper if upper is not None else 100.0, 'hours_over': over * step,
        })
    return {
        'scenario_id': scenario_id, 'kind': kind, 'result_id': identifier,
        'before': 'planning case' if prime else 'REF', 'step_hours': step,
        'period': [stamps[0], stamps[-1]] if stamps else None,
        'total_pairs': len(found),
        'contingencies': len({r[0] for r in found}), 'elements': len({r[1] for r in found}),
        'pairs': pairs,
    }
