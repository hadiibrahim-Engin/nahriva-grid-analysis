"""Native GridLens data and original source findings, separate from dashboard criteria."""

import json

from app.simulation import values
from app.simulation.grids import grid_name
from app.simulation.states import INVALID_OR_MISSING

# Version of the result contract written by the bridge (gl_assessments.result_schema_version). 1: imports made
# before analyses, master data and import status were recorded; 2: with them.
RESULT_SCHEMA_VERSION = 4

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
CREATE TABLE IF NOT EXISTS gl_evaluations (
    assessment_id TEXT NOT NULL REFERENCES gl_assessments(id), case_id TEXT NOT NULL,
    payload TEXT NOT NULL, PRIMARY KEY(assessment_id, case_id)
);
CREATE TABLE IF NOT EXISTS gl_results (
    id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES gl_assessments(id),
    case_id TEXT NOT NULL, kind TEXT NOT NULL, native_name TEXT NOT NULL, native_path TEXT NOT NULL,
    status TEXT NOT NULL, reason TEXT NOT NULL, metadata TEXT NOT NULL, analysis_run_id TEXT
);
CREATE INDEX IF NOT EXISTS gl_results_assessment ON gl_results(assessment_id, case_id, kind);
-- Rows whose native identity could not be resolved. Never used as an identified contingency or inferred OK.
CREATE TABLE IF NOT EXISTS gl_unresolved_rows (
    result_id TEXT NOT NULL REFERENCES gl_results(id), t INTEGER NOT NULL, row_index INTEGER NOT NULL,
    diagnostic TEXT NOT NULL, cells TEXT NOT NULL, PRIMARY KEY(result_id,t,row_index)
);
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


def named_assessment(result):
    if result is not None:
        result['name'] = result['configuration'].get('analysis_name') or '{} - {}'.format(result['project'], result['native_run_id'])
    return result


def assessments(db):
    return [named_assessment(decode_row(row, ('settings', 'configuration'))) for row in db.execute(
        'SELECT * FROM gl_assessments ORDER BY created_at DESC, id DESC')]


def assessment(db, identifier, summary=False):
    result = decode_row(db.execute('SELECT * FROM gl_assessments WHERE id=?', (identifier,)).fetchone(),
                        ('settings', 'configuration'))
    if result is not None:
        result['cases'] = [decode_row(row, ('definition',)) for row in db.execute(
            'SELECT * FROM gl_cases WHERE assessment_id=? ORDER BY rowid', (identifier,))]
        payload = "json_remove(payload,'$.n1.statistics','$.n1.reference_statistics')" if summary else 'payload'
        result['evaluations'] = {row[0]: json.loads(row[1]) for row in db.execute(
            'SELECT case_id,' + payload + ' FROM gl_evaluations WHERE assessment_id=?', (identifier,))}
        if summary:
            for evaluation in result['evaluations'].values():
                episodes = evaluation.get('episodes') or []
                evaluation['episodes_total'] = len(episodes)
                evaluation['episodes'] = episodes[:100]
        result['results'] = [decode_row(row, ('metadata',)) for row in db.execute(
            'SELECT * FROM gl_results WHERE assessment_id=? ORDER BY rowid', (identifier,))]
    return named_assessment(result)


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


def sweep_index(db, analysis=None):
    """Native n-1 cases of ONE analysis, independent of QDS links. Reads metadata only."""
    from app.simulation import across
    chosen = across.resolve_analysis(db, analysis)
    if chosen is None:
        latest = db.execute('SELECT id FROM gl_assessments ORDER BY created_at DESC,rowid DESC LIMIT 1').fetchone()
        chosen = latest[0] if latest else None
    state = db.execute('SELECT status FROM gl_assessments WHERE id=?', (chosen,)).fetchone()
    cases = {}
    for row in db.execute(
        "SELECT r.id,r.case_id,r.kind,r.status,r.reason,COALESCE(c.name,r.case_id) AS name "
        "FROM gl_results r LEFT JOIN gl_cases c ON c.assessment_id=r.assessment_id AND c.case_id=r.case_id "
        "WHERE r.assessment_id=? AND r.kind IN (?,?) ORDER BY r.rowid", (chosen, 'n-1', "(n-1)'")):
        item = cases.setdefault(row['case_id'], {'id': chosen + '-' + row['case_id'], 'case_id': row['case_id'],
                                                'name': row['name'], 'sweeps': []})
        item['sweeps'].append({'id': row['id'], 'kind': row['kind'], 'status': row['status'], 'reason': row['reason']})
    return {'analysis': chosen, 'status': state[0] if state else None, 'scenarios': list(cases.values())}


def n1_pairs(db, scenario_id, kind="(n-1)'", start=None, end=None, limit=100, grid=None, kv=None,
             equipment="all", element_ids=None):
    """Which contingency overloads which branch, and how strongly: per pair the highest loading after the
    contingency, the loading before it at that time, and the hours above the branch's limit, worst first.

    `grid`, `kv`, `equipment` and `element_ids` keep the pairs whose overloaded branch matches the plot filter;
    the contingency may lie anywhere, since its effect across grids is the point. Filtering happens before
    `limit`, so a chosen element cannot disappear merely because it was outside the unfiltered top N.

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
    columns = {r[0]: r[1:] for r in db.execute(
        "SELECT c.column_id, c.element_id, c.name, c.path, e.nominal_kv, "
        "CASE WHEN c.class_name IN ('ElmTr2', 'ElmTr3') THEN 'transformer' ELSE 'line' END FROM gl_columns c "
        'LEFT JOIN gl_elements e ON e.assessment_id=? AND e.element_id=c.element_id WHERE c.result_id=?',
        (assessment, identifier))}
    chosen_ids = set(element_ids or ())
    if grid is not None or kv is not None or equipment != 'all' or chosen_ids:
        found = [r for r in found if (grid is None or grid_name(columns[r[1]][2]) == grid)
                 and (kv is None or columns[r[1]][3] == kv)
                 and (equipment == 'all' or columns[r[1]][4] == equipment)
                 and (not chosen_ids or columns[r[1]][0] in chosen_ids)]
    found.sort(key=lambda r: (-r[2], -r[4]))
    shown = found[:limit]
    names = dict(db.execute('SELECT id, name FROM gl_contingencies WHERE result_id=?', (identifier,)).fetchall())
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
        element_id, name, path, nominal_kv, element_type = columns[column]
        pairs.append({
            'contingency': names.get(contingency, contingency), 'element_id': element_id, 'element': name,
            'grid': grid_name(path), 'nominal_kv': nominal_kv, 'type': element_type,
            'post': post, 't': t, 'pre': before.get((element_id, t)),
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
