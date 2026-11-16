"""GridLens calculation -> native results -> local dashboard storage.

Runs inside PowerFactory; the source Qt manager and Parquet writer need PyQt and pyarrow. All calculation,
case-manager and restoration logic belongs to gridlens_runtime (the Outage
Assessment main.py). This adapter reads native results after restoration; it
then stores the original evaluation without report table publication.

Every QDS run and every n-1 sweep is committed on its own, REF first: the
dashboard shows the first scenario while the remaining ones are still read.
"""

import hashlib
import json
import math
import uuid
from array import array
from contextlib import ExitStack
from datetime import datetime, timezone
from itertools import repeat

import gridlens_runtime as engine
from app.simulation import across, areas, imports, prepared
from app.simulation import values as value_files
from app.simulation.gridlens_store import RESULT_SCHEMA_VERSION
from app.simulation.grids import grid_name
from app.simulation.store import ScenarioStore


STANDARD_METRICS = {
    'c:loading': 'loading', 'm:loading': 'loading',
    'm:u': 'voltage', 'm:u1': 'voltage',
    'm:P:bus1': 'active_power', 'm:P:bushv': 'active_power',
    'm:Q:bus1': 'reactive_power', 'm:Q:bushv': 'reactive_power',
    'm:S:bus1': 'apparent_power', 'm:S:bushv': 'apparent_power',
    'm:I:bus1': 'current', 'm:I:bushv': 'current',
}
# Rows handed to SQLite per executemany call for sparse n-1 cells.
CELL_BATCH = 50000


def identifier(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def text_json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def _unit(result, column):
    try:
        return str(result.GetUnit(column) or '')
    except Exception:
        return ''


def _category(kind):
    return ('bus' if kind == 'ElmTerm' else 'transformer' if kind in ('ElmTr2', 'ElmTr3') else 'line' if kind == 'ElmLne'
            else areas.category(kind) or 'other')


def _ends(obj):
    """Grids (areas) of the first (bus1/bushv) and second (bus2/buslv) terminal of a branch; None when unknown."""
    def grid_at(attributes):
        for attribute in attributes:
            cubicle = engine.safe_attr(obj, attribute)
            terminal = engine.safe_attr(cubicle, 'cterm') if cubicle else None
            if terminal:
                return grid_name(engine.object_key(terminal))
        return None
    return grid_at(('bus1', 'bushv')), grid_at(('bus2', 'buslv'))


class Elements:
    """What the import needs of a monitored object, read from PowerFactory once per import.

    Every kept result of one run records the same objects; name, class, grid
    scope, nominal voltage and voltage band are asked once and reused by every later QDS run and
    sweep. Without a grid selection every element is in scope and its grid is not
    read at all, as main.py does. Every assessed element is written once to gl_elements (the master data
    of the analysis), inside the transaction of the run that first records it: `flush()` writes the elements met
    since the last call in one statement.
    """

    def __init__(self, project_path, db=None, assessment_id=None):
        self.project_path = project_path
        self.db, self.assessment_id = db, assessment_id
        self.scoped = bool(engine.current_setting('monitoring_grids') or engine.GRID_NAME_FILTER)
        self._known = {}
        self._rows, self._ends = [], []

    def flush(self):
        if self.db is not None:
            self.db.executemany('INSERT OR IGNORE INTO gl_elements VALUES(?,?,?,?,?,?,?,?)', self._rows)
            self.db.executemany('INSERT OR IGNORE INTO gl_branch_ends VALUES(?,?,?,?)', self._ends)
        self._rows, self._ends = [], []

    def get(self, obj):
        """The facts of `obj`, or None when it is not assessed (out of scope or a DC node)."""
        key = engine.object_key(obj)
        found = self._known.get(key)
        if found is None:
            kind = engine.class_name(obj)
            assessed = (not self.scoped or engine.element_in_scope(obj)) and not (
                kind == 'ElmTerm' and engine.is_dc_terminal(obj))
            found = self._known[key] = {
                'key': key, 'id': identifier(self.project_path + '|' + key), 'name': engine.object_name(obj),
                'class': kind, 'category': _category(kind), 'assessed': assessed, 'obj': obj,
            }
            if assessed:
                found['nominal_kv'] = engine.nominal_voltage(obj)
                found['area'] = grid_name(key)
                if found['category'] in ('line', 'transformer'):
                    found['ends'] = _ends(obj)
                # mrid stays NULL: no verified PowerFactory attribute supplies the CGMES mRID yet.
                self._rows.append((self.assessment_id, found['id'], found['name'], kind, key, found['area'],
                                   found['nominal_kv'], None))
                if 'ends' in found:
                    self._ends.append((self.assessment_id, found['id'], *found['ends']))
        return found if found['assessed'] else None

    def limits(self, entry, metric):
        """(lower, upper) of the metric: the voltage band of a node, the loading limit of a branch."""
        if metric == 'voltage':
            if 'band' not in entry:
                entry['band'] = engine.voltage_band(entry.get('nominal_kv'))
            return entry['band']
        if metric == 'loading' and entry['category'] in ('line', 'transformer'):
            return None, engine.loading_limit(entry['category'])
        return None, None


def _column(db, result_id, column_id, entry, variable, unit):
    metric = STANDARD_METRICS.get(variable, variable.replace(':', '_'))
    db.execute('INSERT OR IGNORE INTO gl_columns VALUES(?,?,?,?,?,?,?,?,?)',
               (result_id, column_id, entry['id'], entry['name'], entry['key'], entry['class'], variable, metric, unit))
    return metric


def _native_result(db, assessment_id, case_id, kind, obj, status, reason='', metadata=None, analysis_run_id=None):
    result_id = uuid.uuid4().hex
    db.execute('INSERT INTO gl_results VALUES(?,?,?,?,?,?,?,?,?,?)', (
        result_id, assessment_id, case_id, kind,
        engine.object_name(obj) if obj is not None else '',
        engine.object_key(obj) if obj is not None else '', status, reason,
        text_json(metadata or {}), analysis_run_id,
    ))
    return result_id


def _run_period(bundle):
    """(start, end) of the period every run of this assessment was calculated over, in epoch seconds.

    main.py sets the QDS period of a run from the planned outages (Settings: QDS period) and restores it
    afterwards; the restored ComStatsim then shows the configured period, not the one the results cover.
    """
    ready = [plan for plan in bundle['request']['cases'] if plan['status'] == engine.PLAN_READY]
    if not bundle.get('n0', True):
        grid = bundle.get('n1_grid')
        return tuple(grid[:2]) if grid else (None, None)
    start, end, _step = engine.span_grid(bundle['qds'], ready)
    return start, end


def _qds_axis(result, period):
    rows, columns = int(result.GetNumberOfRows()), int(result.GetNumberOfColumns())
    if rows <= 0 or rows > engine.MAX_RESULT_ROWS:
        raise engine.OutageAssessmentError('The QDS result has no rows or exceeds MAX_RESULT_ROWS.')
    column = engine.time_column(result, columns, rows)
    unit = engine.normalize_time_unit(result.GetUnit(column))
    if unit not in ('s', 'min', 'h', 'd'):
        raise engine.OutageAssessmentError('Unsupported QDS time unit: ' + str(unit))
    hours = []
    for row, value in enumerate(engine.read_column(result, column, rows)):
        if value is None:
            raise engine.OutageAssessmentError('The QDS time axis contains an invalid value.')
        hours.append(engine.time_in_hours(value, unit, row))
    if any(right <= left for left, right in zip(hours, hours[1:])):
        raise engine.OutageAssessmentError('The QDS time axis is not strictly increasing.')
    start, end = period
    origin = 0.0
    encoding = 'absolute'
    if not engine.is_absolute_time_axis(hours):
        if start is None or abs(hours[0]) > 1e-9:
            raise engine.OutageAssessmentError('Relative QDS time axis has no unambiguous configured origin.')
        origin, encoding = start, 'relative_to_qds_start'
    timestamps = [int(round(origin + hour * 3600)) for hour in hours]
    if len(set(timestamps)) != rows:
        raise engine.OutageAssessmentError('QDS timestamps cannot be represented uniquely in epoch seconds.')
    if start is not None and end is not None and (timestamps[0] < start - 1 or timestamps[-1] > end + 1):
        raise engine.OutageAssessmentError('QDS timestamps lie outside the period the run was calculated over.')
    return column, timestamps, encoding


def _values(result, column, rows):
    """All values of one QDS column from one GetColumnValues call.

    A column of finite numbers (the usual case) is checked as a whole; any other
    column is converted value by value as main.py does (decimal commas, a
    de-energised NaN becomes None). Without an IntVec main.py reads cell by cell.
    """
    vector = engine.COLUMN_BUFFER
    if vector is not None:
        try:
            code = engine.finite_number(result.GetColumnValues(vector, column))
            bulk = engine.safe_attr(vector, 'V')
        except Exception:
            code, bulk = None, None
        if code == 0.0 and isinstance(bulk, (list, tuple)) and len(bulk) == rows:
            try:
                numbers = array('d', bulk)
            except TypeError:
                numbers = None
            # The sum of finite numbers is finite unless it overflows; then the slow path decides.
            if numbers is not None and math.isfinite(sum(numbers)):
                return numbers.tolist()
            return [engine.finite_number(value) for value in bulk]
    return engine.read_column(result, column, rows)


# Per time of a QDS run: extremes and violations (pf_run_times), aggregated in groups of series with pyarrow.
RunTimes = prepared.RunTimes
ScenarioStats = prepared.RunStats


def _read_qds(db, assessment_id, run, bundle, catalog, elements, database, stats=None, window_sets=()):
    """One native column at a time, with every sample retained for the existing widgets.

    The values go straight into the run's Parquet file (app/simulation/values.py); SQLite gets the series, limits
    and the summaries. The file becomes visible together with the commit of the run.
    """
    obj = run.get('snapshot')
    case_id = run['id']
    analysis_id = uuid.uuid4().hex
    metadata = {'provenance': run.get('run_note') or 'CALCULATED', 'fingerprint': engine.result_fingerprint(obj)}
    result_id = _native_result(db, assessment_id, case_id, 'QDS', obj, 'completed',
                               metadata=metadata, analysis_run_id=analysis_id)
    writer = None
    obj.Load()
    try:
        time_column, timestamps, encoding = _qds_axis(obj, catalog['run_period'])
        count = int(obj.GetNumberOfColumns())
        db.execute('INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)', (
            analysis_id, run.get('name') or case_id, catalog['project'], catalog['study_case'], 'PowerFactory / GridLens', 'completed'))
        db.executemany('INSERT INTO gl_times VALUES(?,?)', zip(repeat(result_id), timestamps))
        chosen = {}
        for column in range(count):
            if column == time_column:
                continue
            owner, variable = obj.GetObject(column), str(obj.GetVariable(column))
            if owner is None or variable.startswith('b:'):
                continue
            entry = elements.get(owner)
            if entry is None:
                continue
            metric = STANDARD_METRICS.get(variable, variable.replace(':', '_'))
            key = entry['key'], metric
            priority = 0 if variable in ('c:loading', 'm:u') else 1
            if key not in chosen or priority < chosen[key][0]:
                chosen[key] = priority, column, entry, variable
        elements.flush()
        if not chosen:
            raise engine.OutageAssessmentError('The QDS result has no in-scope numeric series.')
        if len(timestamps) * len(chosen) > engine.MAX_RESULT_CELLS:
            raise engine.OutageAssessmentError('QDS raw result exceeds MAX_RESULT_CELLS.')
        incomplete = False
        writer = value_files.ValueWriter(database, analysis_id)
        per_time = RunTimes(len(timestamps))
        per_area = areas.AreaTimes(len(timestamps))
        per_scenario = ScenarioStats(timestamps, window_sets)
        # The transaction already owns SQLite's write lock. Reserve ids once, then insert metadata in batches.
        next_id = db.execute('SELECT COALESCE(MAX(id),0)+1 FROM analysis_series').fetchone()[0]
        columns, series, limits, metrics, equipment = [], [], [], {}, {}
        for offset, (_priority, column, entry, variable) in enumerate(chosen.values()):
            unit = _unit(obj, column)
            metric = STANDARD_METRICS.get(variable, variable.replace(':', '_'))
            columns.append((result_id, column, entry['id'], entry['name'], entry['key'], entry['class'], variable, metric, unit))
            equipment.setdefault(entry['id'], (analysis_id, entry['id'], entry['name'], entry['class'], entry['category'], entry['key']))
            lower, upper = elements.limits(entry, metric)
            metrics.setdefault(metric, (analysis_id, metric, metric.replace('_', ' ').title(), unit, lower, upper))
            if lower is not None or upper is not None:
                limits.append((analysis_id, entry['id'], metric, lower, upper))
            series_id = next_id + offset
            series.append((series_id, analysis_id, metric, entry['id']))
        db.executemany('INSERT INTO gl_columns VALUES(?,?,?,?,?,?,?,?,?)', columns)
        db.executemany('INSERT INTO analysis_elements VALUES(?,?,?,?,?,?)', equipment.values())
        db.executemany('INSERT INTO analysis_metrics VALUES(?,?,?,?,?,?)', metrics.values())
        db.executemany('INSERT INTO pf_element_limits VALUES(?,?,?,?,?)', limits)
        db.executemany('INSERT INTO analysis_series VALUES(?,?,?,?)', series)
        metadata_rows = {'analysis_series': series, 'analysis_elements': equipment.values(), 'pf_element_limits': limits}
        for row, (_priority, column, entry, variable) in zip(series, chosen.values()):
            series_id, _run, metric, _element = row
            lower, upper = elements.limits(entry, metric)
            native_values = _values(obj, column, len(timestamps))
            arrow = writer.pa.array(native_values, writer.pa.float64())
            writer.add(series_id, timestamps, arrow)
            per_time.add(metric, entry['category'], arrow, lower, upper)
            per_scenario.add(entry['id'], metric, arrow, lower, upper)
            if metric == areas.METRIC:
                per_area.add(entry['category'], entry['area'], native_values, entry.get('ends'))
            if arrow.null_count:
                incomplete = True
                db.executemany('INSERT INTO gl_values VALUES(?,?,?,?,?,?,?)',
                               ((result_id, t, '', column, None, None, 'invalid_or_missing')
                                for t, value in zip(timestamps, native_values) if value is None))
        per_time.store(db, analysis_id, timestamps)
        per_area.store(db, analysis_id, timestamps)
        db.execute('INSERT INTO pf_run_values VALUES(?,?,?,?,?,?)', (analysis_id, *writer.close(db, metadata_rows)))
        metadata.update(time_encoding=encoding, time_unit='epoch_seconds_utc', rows=len(timestamps), columns=len(chosen))
        status = 'incomplete' if incomplete else 'completed'
        db.execute('UPDATE gl_results SET metadata=?,status=? WHERE id=?', (text_json(metadata), status, result_id))
        db.execute('UPDATE analysis_runs SET status=? WHERE id=?', (status, analysis_id))
        if incomplete:
            db.execute('INSERT INTO pf_run_notes VALUES(?,?,?)', (analysis_id, status, 'One or more native QDS values are invalid or missing.'))
    except BaseException:
        if writer is not None:
            writer.abort()  # the run's transaction rolls back; its file must not stay behind
        raise
    finally:
        obj.Release()
    if stats is not None:
        stats[analysis_id] = per_scenario
    return result_id, analysis_id


def _sweep_cells(sub, column, rows):
    """(code, value) of every row of one sub-result column.

    One GetColumnValues call when every row holds a positive value, as main.py
    reads n-1 columns; otherwise cell by cell, so that code 3 (inside the
    recording limits), a real zero and an unreadable cell stay distinct.
    """
    vector = engine.COLUMN_BUFFER
    if vector is not None:
        try:
            code = engine.finite_number(sub.GetColumnValues(vector, column))
            bulk = engine.safe_attr(vector, 'V')
        except Exception:
            code, bulk = None, None
        if code == 0.0 and isinstance(bulk, (list, tuple)) and len(bulk) == rows:
            numbers = [engine.finite_number(value) for value in bulk]
            if all(number is not None and number > 0.0 for number in numbers):
                return [(0, number) for number in numbers]
    cells = []
    for row in range(rows):
        try:
            cells.append(engine._status_pair(sub.GetValue(row, column)))
        except Exception:
            cells.append((None, None))
    return cells


class SweepSummary:
    """The n-1 summaries of one sweep, built while its cells are read (gl_n1_hourly, gl_n1_columns).

    A sweep holds millions of cells; the dashboard reads these summaries by key instead and answers in
    milliseconds whatever the size of the sweep. Limits are those of the run's settings.
    """

    def __init__(self, db, result_id):
        self.db, self.result_id = db, result_id
        self.columns = {}
        self.hourly = []

    def column(self, slot, metric, lower, upper):
        self.columns.setdefault(slot, {'metric': metric, 'lower': lower, 'upper': upper, 'low': None, 'high': None,
                                       'times': 0, 'violations': 0})

    def start(self, moment):
        self.moment = moment

    def add(self, slot, low, low_fault, high, high_fault, violating):
        """The extremes of one column at the current study time; `violating` the contingencies beyond a limit."""
        info = self.columns[slot]
        moment = self.moment
        self.hourly.append((self.result_id, slot, moment, low, low_fault, high, high_fault, len(violating)))
        if info['low'] is None or low < info['low'][0]:
            info['low'] = (low, moment, low_fault)
        if info['high'] is None or high > info['high'][0]:
            info['high'] = (high, moment, high_fault)
        info['times'] += bool(violating)
        info['violations'] += len(violating)
        if len(self.hourly) >= CELL_BATCH:
            self.flush()

    def flush(self):
        self.db.executemany('INSERT INTO gl_n1_hourly VALUES(?,?,?,?,?,?,?,?)', self.hourly)
        self.hourly.clear()

    def finish(self):
        self.flush()
        rows = []
        for slot, info in self.columns.items():
            if info['high'] is None:
                continue
            low, high, lower, upper = info['low'][0], info['high'][0], info['lower'], info['upper']
            beyond = [value for value in (None if upper is None else high - upper, None if lower is None else lower - low)
                      if value is not None]
            rows.append((self.result_id, slot, info['metric'], *info['low'], *info['high'], lower, upper,
                         max(beyond) if beyond else None, info['times'], info['violations']))
        self.db.executemany('INSERT INTO gl_n1_columns VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', rows)


def _read_sweep(db, assessment_id, case_id, kind, sweep, entry, elements):
    obj = sweep.get('kept')
    if obj is None:
        raise engine.OutageAssessmentError('No kept native ' + kind + ' result is available for raw import.')
    metadata = {
        'requested_times': sweep.get('window_times') or [],
        'calculated_times': sweep.get('calculated_times') or [],
        'recording_limits': sweep.get('recording_limits') or {},
        'filtered_out': entry.get('filtered_out') or {},
        'calculated_with': entry.get('calculated_with') or engine.n1_filter_text(),
        'phase': None, 'phase_source': 'not exposed by the verified native result interface',
        'implicit_cell_code': 3,
    }
    result_id = _native_result(db, assessment_id, case_id, kind, obj, 'completed', metadata=metadata)
    elements_of = entry.get('elements_of') or {}
    filtered = entry.get('filtered_out') or {}
    known = set()

    def contingency(path, name):
        contingency_id = identifier(path)
        if contingency_id not in known:
            known.add(contingency_id)
            db.execute('INSERT OR IGNORE INTO gl_contingencies VALUES(?,?,?,?,?)',
                       (result_id, contingency_id, name, path, text_json(sorted(elements_of.get(path) or ()))))
        return contingency_id

    for path in elements_of:
        if path not in filtered:
            contingency(path, path.rsplit('\\', 1)[-1].removesuffix('.ComOutage'))
    column_ids, cells = {}, []
    unreadable = 0
    unresolved = 0
    moments = set()
    summary = SweepSummary(db, result_id)
    for sub in engine._contents(obj, '*.ElmRes'):
        moment = engine.finite_number(engine.safe_attr(sub, 'cnttime'))
        if moment is None or moment != round(moment):
            raise engine.OutageAssessmentError('Contingency result has no exact epoch-second cnttime.')
        moment = int(moment)
        if moment in moments:
            raise engine.OutageAssessmentError('Contingency result contains duplicate study times.')
        moments.add(moment)
        db.execute('INSERT INTO gl_times VALUES(?,?)', (result_id, moment))
        summary.start(moment)
        sub.Load()
        try:
            columns = []
            for column in range(int(sub.GetNumberOfColumns())):
                owner, variable = sub.GetObject(column), str(sub.GetVariable(column))
                if owner is None or variable not in ('c:loading', 'm:u'):
                    continue
                element = elements.get(owner)
                if element is None:
                    continue
                key = element['key'], variable
                if key not in column_ids:
                    column_ids[key] = len(column_ids)
                    metric = _column(db, result_id, column_ids[key], element, variable, _unit(sub, column))
                    summary.column(column_ids[key], metric, *elements.limits(element, metric))
                columns.append((column, column_ids[key]))
            db.executemany('INSERT INTO gl_time_columns VALUES(?,?,?)', ((result_id, moment, slot) for _c, slot in columns))
            rows = int(sub.GetNumberOfRows())
            faults, seen_faults = [], set()
            for row in range(rows):
                outage, diagnostic = engine.contingency_row_object(sub, row)
                if outage is None:
                    # Preserve raw cells without inventing a contingency or pretending that coverage is complete.
                    raw_cells = []
                    for column, slot in columns:
                        try:
                            code, value = engine._status_pair(sub.GetValue(row, column))
                        except Exception:
                            code, value = None, None
                        number = engine.finite_number(value) if code == 0 else None
                        state = 'value' if number is not None else 'not_recorded' if code == 3 else 'invalid' if code == 0 else 'read_error'
                        raw_cells.append({'column_id': slot, 'code': code, 'value': number, 'state': state})
                    db.execute('INSERT INTO gl_unresolved_rows VALUES(?,?,?,?,?)',
                               (result_id, moment, row, text_json(diagnostic), text_json(raw_cells)))
                    unresolved += 1
                    faults.append(None)
                    continue
                path = engine.object_key(outage)
                fault = None if path in filtered else contingency(path, engine.object_name(outage))
                if fault is not None and fault in seen_faults:
                    raise engine.OutageAssessmentError('Duplicate contingency identity in {} at study time {}, row {}: {}'.format(
                        engine.object_key(sub), moment, row, path))
                faults.append(fault)
                if fault is not None:
                    seen_faults.add(fault)
            db.executemany('INSERT INTO gl_pairs VALUES(?,?,?)',
                           ((result_id, moment, fault) for fault in faults if fault is not None))
            for column, slot in columns:
                lower, upper = summary.columns[slot]['lower'], summary.columns[slot]['upper']
                low = high = low_fault = high_fault = None
                violating = []
                for fault, (raw_code, raw_value) in zip(faults, _sweep_cells(sub, column, rows)):
                    if fault is None or raw_code == 3:
                        continue
                    value = engine.finite_number(raw_value) if raw_code == 0 else None
                    if value is None:
                        unreadable += 1
                        cells.append((result_id, moment, fault, slot, None, raw_code, 'invalid' if raw_code == 0 else 'read_error'))
                        continue
                    cells.append((result_id, moment, fault, slot, value, raw_code, 'value'))
                    if high is None or value > high:
                        high, high_fault = value, fault
                    if low is None or value < low:
                        low, low_fault = value, fault
                    if (upper is not None and value > upper) or (lower is not None and value < lower):
                        violating.append(fault)
                if high is not None:
                    summary.add(slot, low, low_fault, high, high_fault, violating)
                if len(cells) >= CELL_BATCH:
                    db.executemany('INSERT INTO gl_values VALUES(?,?,?,?,?,?,?)', cells)
                    cells.clear()
        finally:
            sub.Release()
    db.executemany('INSERT INTO gl_values VALUES(?,?,?,?,?,?,?)', cells)
    elements.flush()
    summary.finish()
    missing = sorted(set(metadata['requested_times']) - moments)
    metadata.update(calculated_times=sorted(moments), missing_times=missing, unreadable_cells=unreadable, unresolved_rows=unresolved)
    reason = '{} contingency row(s) could not be identified; raw cells and diagnostics retained separately.'.format(unresolved) if unresolved else ''
    db.execute('UPDATE gl_results SET metadata=?,status=?,reason=? WHERE id=?',
               (text_json(metadata), 'incomplete' if missing or unreadable or unresolved else 'completed', reason, result_id))
    return result_id


def _save_scenario(db, assessment_id, plan, loaded, reused, catalog):
    """Link one planning case to its REF and OUTAGE run, so that the dashboard lists it."""
    case_id = plan['id']
    scenario_id = assessment_id + '-' + case_id
    payload = {'name': plan['name'], 'outage_ids': [identifier(r['key']) for r in plan['members']]}
    stamp = datetime.now(timezone.utc).isoformat()
    db.execute('INSERT INTO pf_jobs(id,kind,payload,status,created_at,finished_at,message) VALUES(?,?,?,?,?,?,?)',
               (scenario_id, 'gridlens', text_json(payload), 'completed', stamp, stamp, 'Native GridLens results imported.'))
    db.execute('INSERT INTO pf_scenarios(id,name,project,study_case,outages,created_at,analysis_id) VALUES(?,?,?,?,?,?,?)',
               (scenario_id, plan['name'], catalog['project'], catalog['study_case'], text_json(payload['outage_ids']), stamp,
                assessment_id))
    db.execute('INSERT INTO pf_scenario_provenance VALUES(?,?)', (scenario_id, catalog['provenance']))
    for key, kind in ((engine.REFERENCE_CASE_ID, 'REF'), (case_id, 'OUTAGE')):
        if key in loaded:
            db.execute('INSERT INTO pf_scenario_runs VALUES(?,?,?)', (scenario_id, loaded[key][1], kind))
    if case_id in reused and case_id in loaded:
        alias_id, source_id = uuid.uuid4().hex, loaded[case_id][0]
        db.execute('INSERT INTO gl_results SELECT ?,assessment_id,?,kind,native_name,native_path,status,reason,metadata,analysis_run_id FROM gl_results WHERE id=?',
                   (alias_id, case_id, source_id))
        for table, fields in (
            ('gl_columns', 'column_id,element_id,name,path,class_name,variable,metric,unit'),
            ('gl_times', 't'),
            ('gl_values', 't,contingency_id,column_id,value,code,state'),
        ):
            db.execute('INSERT INTO ' + table + ' SELECT ?,' + fields + ' FROM ' + table + ' WHERE result_id=?',
                       (alias_id, source_id))
    return scenario_id


def import_results(bundle, database, on_saved=None):
    with imports.serialized(database):
        return _import_results(bundle, database, on_saved)


def _import_results(bundle, database, on_saved=None):
    """Store one restored native assessment, with no classification or report tables.

    The assessment and its cases come first, then every QDS run (REF first) and every n-1 sweep in a
    transaction of its own; a planning case is listed in the dashboard as soon as its run is stored.
    `on_saved(done, total, detail, scenarios)` is called after every commit. A failure keeps what is
    stored, marks the cases that were not stored and leaves the native results for a new import.
    """
    request, app, logger = bundle['request'], bundle['app'], bundle['logger']
    project = app.GetActiveProject()
    catalog = {
        'project': engine.object_name(project), 'project_path': engine.object_key(project),
        'study_case': engine.object_name(bundle['study_case']), 'study_case_path': engine.object_key(bundle['study_case']),
        'period': list(engine.qds_period(bundle['qds'])) if bundle.get('n0', True) and bundle['qds'] is not None else list(_run_period(bundle)), 'outages': [],
        'data_source': 'PowerFactory / GridLens', 'engine_version': engine.PUBLISHER_VERSION,
        'settings_snapshot': request['settings_snapshot'], 'native_run_id': request['run_id'],
    }
    run_period = _run_period(bundle)
    catalog['run_period'] = list(run_period)
    for record in request['records']:
        start, end = record['window']
        catalog['outages'].append({
            'id': identifier(record['key']), 'name': record['name'], 'path': record['key'],
            'equipment_name': record.get('equipment_name') or '', 'equipment_paths': list(record.get('component_keys') or ()),
            'start': start, 'end': end, 'in_period': engine.window_overlaps_period(record['window'], tuple(catalog['period'])),
            'ignored': bool(record.get('originally_ignored')), 'priority': record.get('priority', 0),
        })
    assessment_id = uuid.uuid4().hex
    catalog['assessment_id'] = assessment_id
    catalog['provenance'] = text_json(catalog)
    plans = {plan['id']: plan for plan in request['cases']}
    runs = bundle['runs']
    reused = {run['id']: run['reuse_of'] for run in runs if run.get('reuse_of')}
    sweeps = []
    for case_id, entry in bundle['n1_runs'].items():
        if entry.get('status') != 'CALCULATED':
            sweeps.append((case_id, None, None))
            continue
        sweeps.extend((case_id, side, kind) for side, kind in (('reference', engine.N1_REFERENCE), ('scenario', engine.N1_PRIME))
                      if entry.get(side))
    total = len(runs) + len(sweeps)
    progress = {'done': 0, 'scenarios': 0}

    def saved(detail):
        progress['done'] += 1
        if on_saved is not None:
            on_saved(progress['done'], total, detail, progress['scenarios'])

    store = ScenarioStore(str(database))
    db = store.db
    imports.recover(db, database)
    elements = Elements(catalog['project_path'], db, assessment_id)
    loaded, stats = {}, {}
    windows_by_run = {engine.REFERENCE_CASE_ID: []}
    sources, remaining = {}, {}
    for plan in plans.values():
        windows = prepared.scenario_windows(catalog['outages'], [identifier(r['key']) for r in plan['members']])
        windows_by_run[engine.REFERENCE_CASE_ID].append(windows)
        source = plan['id']
        while source in reused:
            source = reused[source]
        sources[plan['id']] = source
        remaining[source] = remaining.get(source, 0) + 1
        if source != engine.REFERENCE_CASE_ID:
            windows_by_run.setdefault(source, []).append(windows)
    engine.open_column_buffer(app)
    try:
        logger.step(6, 'Read native results for the dashboard (no report evaluation)')
        with db:
            kinds = (['QDS'] if any(not run.get('failed') for run in runs) else []) + sorted(
                {kind for _case, _side, kind in sweeps if kind})
            db.execute(
                'INSERT INTO gl_assessments(id,native_run_id,project,study_case,engine_version,created_at,settings,'
                'configuration,mode,status,source_system,calculation_types,project_path,study_case_path,created_by,'
                'period_start,period_end,result_schema_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (
                    assessment_id, request['run_id'], catalog['project'], catalog['study_case'], engine.PUBLISHER_VERSION,
                    datetime.now(timezone.utc).isoformat(), text_json(request['settings_snapshot']),
                    text_json(dict(request.get('config') or {}, analysis_name=(request.get('config') or {}).get('analysis_name', '').strip()
                                   or '{} - {}'.format(catalog['project'], request['run_id']))), 'kept' if request.get('evaluate_stamp') else 'calculated',
                    'importing', 'PowerFactory', text_json(kinds), catalog['project_path'], catalog['study_case_path'],
                    engine._generated_by(), *(None if t is None else int(t) for t in run_period), RESULT_SCHEMA_VERSION))
            db.execute('INSERT INTO pf_catalog VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at',
                       (catalog['provenance'], datetime.now(timezone.utc).isoformat()))
            for plan in plans.values():
                definition = {
                    'windows': plan['windows'], 'fingerprint': plan['fingerprint'],
                    'outage_ids': [identifier(record['key']) for record in plan['members']],
                    'background_ids': [identifier(record['key']) for record in request['background']],
                    'states': [(lo, hi, sorted(keys)) for lo, hi, keys in plan['states']],
                }
                db.execute('INSERT INTO gl_evaluations VALUES(?,?,?)',
                           (assessment_id, plan['id'], text_json({'status': 'pending' if bundle.get('evaluate_source') and plan['status'] == engine.PLAN_READY else 'not_evaluated', 'reason': plan['reason']})))
                db.execute('INSERT INTO gl_cases VALUES(?,?,?,?,?,?)',
                           (assessment_id, plan['id'], plan['name'], plan['status'], plan['reason'], text_json(definition)))
        for run in runs:
            with db:
                if run.get('reuse_of'):
                    if run['reuse_of'] not in loaded:
                        raise engine.OutageAssessmentError('The reused QDS source could not be imported.')
                    loaded[run['id']] = loaded[run['reuse_of']]
                elif run.get('failed') or run.get('snapshot') is None:
                    _native_result(db, assessment_id, run['id'], 'QDS', None, 'failed', str(run.get('failed') or 'No result'))
                    db.execute('UPDATE gl_cases SET status=?,reason=? WHERE assessment_id=? AND case_id=?',
                               ('FAILED', str(run.get('failed') or 'No result'), assessment_id, run['id']))
                else:
                    logger.detail('Reading QDS ' + run['id'] + ': ' + engine.object_key(run['snapshot']))
                    loaded[run['id']] = _read_qds(db, assessment_id, run, bundle, catalog, elements, database, stats, windows_by_run.get(run['id'], []))
                if run['id'] in plans and run['id'] in loaded:
                    scenario_id = _save_scenario(db, assessment_id, plans[run['id']], loaded, reused, catalog)
                    # The dashboard's summary of the scenario, committed with it: the first view needs no
                    # reduction of the stored values (about 1 s per scenario on a year of hourly values).
                    across.prepare_cells(store, scenario_id, stats=stats)
                    source = sources[run['id']]
                    remaining[source] -= 1
                    if source != engine.REFERENCE_CASE_ID and not remaining[source]:
                        stats.pop(loaded[run['id']][1], None)
                    progress['scenarios'] += 1
            saved('QDS ' + run['id'])
        if not bundle.get('n0', True):
            for plan in plans.values():
                if plan['id'] not in bundle['n1_runs']:
                    continue
                with db:
                    _save_scenario(db, assessment_id, plan, loaded, reused, catalog)
                    progress['scenarios'] += 1
        for case_id, side, kind in sweeps:
            entry = bundle['n1_runs'][case_id]
            with db:
                if side is None:
                    kind = entry.get('kind') or engine.N1_REFERENCE
                    _native_result(db, assessment_id, case_id, kind, None, 'not_calculated',
                                   entry.get('reason') or 'No native result')
                else:
                    logger.detail('Reading ' + kind + ' of case ' + case_id)
                    _read_sweep(db, assessment_id, case_id, kind, entry[side], entry, elements)
            saved(kind + ' ' + case_id)
        with db:
            db.execute("UPDATE gl_assessments SET status='complete' WHERE id=?", (assessment_id,))
        logger.write('DASHBOARD', 'Native results imported without report evaluation: ' + assessment_id, 6)
        return {'assessment_id': assessment_id, 'native_run_id': request['run_id'], 'database': str(database),
                'cases': len(plans), 'qds_results': len(loaded)}
    except BaseException as exc:
        # What is committed stays visible; the cases without a stored run say why they are missing.
        try:
            with db:
                db.executemany('UPDATE gl_cases SET status=?,reason=? WHERE assessment_id=? AND case_id=?',
                               (('IMPORT FAILED', 'Import stopped: ' + str(exc)[:500], assessment_id, case_id)
                                for case_id in plans if case_id not in loaded))
                db.execute("UPDATE gl_assessments SET status='failed' WHERE id=?", (assessment_id,))
            imports.recover(db, database)
        except Exception:
            pass
        raise
    finally:
        engine.close_column_buffer()
        store.close()


def run_assessment(app, database, on_saved=None):
    imported = None
    ownership = ExitStack()

    def consume(bundle):
        nonlocal imported
        ownership.enter_context(imports.serialized(database))
        imported = _import_results(bundle, database, on_saved)
        store = ScenarioStore(str(database))
        try:
            with store.db:
                store.db.execute("UPDATE gl_assessments SET status='evaluating' WHERE id=?", (imported['assessment_id'],))
        finally:
            store.close()
        return imported

    try:
        return engine.execute_outage_assessment(
            app, result_consumer=consume, assessment_consumer=save_assessments)
    except BaseException as exc:
        if imported is not None:
            store = ScenarioStore(str(database))
            try:
                with store.db:
                    store.db.execute(
                        "UPDATE gl_evaluations SET payload=? WHERE assessment_id=? AND json_extract(payload,'$.status')='pending'",
                        (text_json({'status': 'failed', 'reason': str(exc)[:1000]}), imported['assessment_id']))
                with store.db:
                    store.db.execute("UPDATE gl_assessments SET status='evaluation_failed' WHERE id=?", (imported['assessment_id'],))
            finally:
                store.close()
        raise
    finally:
        try:
            engine.reset_settings()
        finally:
            ownership.close()


def assessment_json(value):
    """Encode source statistics, including tuple-keyed counters, without losing key structure."""
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            return {'entries': [{'key': assessment_json(key), 'value': assessment_json(item)}
                                for key, item in value.items()]}
        return {key: assessment_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [assessment_json(item) for item in (sorted(value) if isinstance(value, set) else value)]
    return value


def save_assessments(imported, results, request):
    """Persist the unmodified 8.2 judgments and episodes separately from dashboard criteria.

    Called only after native state restoration, import and original evaluation. Never serialize PF objects
    or the large value arrays: episode rows use the same formatting as the source assessment.
    """
    store = ScenarioStore(imported['database'])
    try:
        with store.db:
            for result in results:
                steps = engine.row_steps(result['hours']) if result.get('hours') else []
                reference = result['id'] == engine.REFERENCE_CASE_ID
                episodes = []
                found = result.get('episodes') or [] if reference else [
                    (record['item'], episode)
                    for records in (result.get('comparison') or {}).values()
                    for record in records
                    for episode in record.get('episodes') or []]
                for item, episode in found:
                    episodes.append(engine._episode_row(0, result, item, episode, steps, reference))
                source = result.get('n1') or {}
                n1 = {key: source[key] for key in ('status', 'reason', 'kind', 'summary', 'times',
                      'contingencies', 'details', 'requested_times', 'statistics', 'reference_statistics') if key in source}
                # n-1 evaluation contains only native assessment data, no PowerFactory handles.
                payload = {'engine_version': engine.PUBLISHER_VERSION, 'status': result.get('status'),
                           'reason': result.get('reason') or result.get('message') or '', 'n0': result.get('judged'),
                           'n1': n1, 'episodes': episodes}
                store.db.execute('INSERT OR REPLACE INTO gl_evaluations VALUES(?,?,?)',
                                 (imported['assessment_id'], result['id'], text_json(assessment_json(payload))))
            store.db.execute("UPDATE gl_assessments SET status='complete' WHERE id=?", (imported['assessment_id'],))
    finally:
        store.close()
