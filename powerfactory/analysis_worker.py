"""Run as a ComPython external script in PowerFactory 2026.

Uses only the Python standard library and the native powerfactory module.
Each invocation synchronizes planned outages and handles one queued web request.
"""
import hashlib
import sys
from datetime import datetime, timezone
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
# Set this to the exact database displayed/configured in the web application.
DATABASE_PATH = PROJECT_DIR / 'backend/data/analysis.sqlite3'
GRID_NAME_FILTER = ''

sys.path.insert(0, str(PROJECT_DIR / 'backend'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import gridlens_engine as engine
from app.simulation.store import ScenarioStore, catalog_signature


def identifier(path):
    return hashlib.sha256(path.encode('utf-8')).hexdigest()


def discover(app):
    project = app.GetActiveProject()
    study_case = app.GetActiveStudyCase()
    qds = app.GetFromStudyCase('ComStatsim')
    if project is None or study_case is None or qds is None:
        raise RuntimeError('Activate a project and a Study Case with configured ComStatsim first.')
    period = engine.qds_period(qds)
    outages = []
    for obj in engine._find_project_outages(app):
        record = engine._outage_record(obj)
        found, ignored = engine._read_setting(obj, 'outserv')
        ignored = engine.finite_number(ignored) if found else None
        start, end = record['window']
        readable = start is not None and end is not None and start <= end and ignored in (0, 1)
        outages.append({'id': identifier(engine.object_key(obj)), 'name': record['name'],
                        'path': engine.object_key(obj), 'source_class': record['source_class'],
                        'equipment_name': record['equipment_name'], 'start': start, 'end': end,
                        'ignored': ignored == 1, 'priority': record['priority'],
                        'in_period': readable and engine.window_overlaps_period(record['window'], period) is True})
    return {'project': engine.object_name(project), 'project_path': engine.object_key(project),
            'study_case': engine.object_name(study_case), 'study_case_path': engine.object_key(study_case),
            'period': list(period), 'grid_name_filter': GRID_NAME_FILTER, 'outages': outages}


def serialize_result(result, project_path, period):
    if result['window'][0] is not None:
        origin = result['window'][0]
        relative_offset = 0
    elif period[0] is not None and abs(result['plot_times'][0]) < 1e-9:
        origin = period[0]
        relative_offset = 0
    else:
        raise RuntimeError('ElmRes has an ambiguous time axis; no timestamps were inferred or saved.')
    elements = {}; metrics = {}; samples = []; limits = []
    for category, entries in result['by_category'].items():
        for item, _stats in entries:
            if len(item['points']) != len(result['labels']):
                raise RuntimeError('Database export requires the complete ElmRes series, not plot downsampling.')
            path = item['key']
            element_id = identifier(project_path + '|' + path)
            elements[element_id] = (element_id, item['element_name'], engine.class_name(item['object']),
                                    'bus' if category == 'voltage' else category, path)
            code = 'voltage' if category == 'voltage' else 'loading'
            metrics[code] = (code, 'Spannung' if code == 'voltage' else 'Auslastung', item['unit'], None, 100 if code == 'loading' else None)
            if code == 'voltage' and item.get('limits'):
                limits.append((element_id, code, *item['limits']))
            for _label, hours, value in item['points']:
                epoch = origin + (hours - relative_offset) * 3600
                if period[0] is not None and period[1] is not None and not period[0]-1 <= epoch <= period[1]+1:
                    raise RuntimeError('ElmRes timestamps lie outside the active QDS period.')
                timestamp = datetime.fromtimestamp(epoch, timezone.utc).isoformat()
                samples.append((element_id, code, timestamp, value, 'ok' if value is not None else 'warning'))
    return {'kind': result['id'], 'elements': list(elements.values()), 'metrics': list(metrics.values()), 'samples': samples, 'limits': limits}


def calculate(app, job, catalog):
    if job['payload']['catalog_signature'] != catalog_signature(catalog):
        raise RuntimeError('PowerFactory project, Study Case, QDS period or planned outages changed since the request. Synchronize and submit again.')
    requested = set(job['payload']['outage_ids'])
    allowed = {o['id'] for o in catalog['outages'] if o['in_period']}
    if not requested or not requested <= allowed:
        raise RuntimeError('The scenario contains unknown outages or outages outside the QDS period.')
    study_case = app.GetActiveStudyCase()
    qds = app.GetFromStudyCase('ComStatsim')
    original_result = engine.safe_attr(qds, 'results')
    found, original_option = engine._read_setting(qds, engine.PLANNED_OUTAGE_OPTION)
    if original_result is None or not found or engine.finite_number(original_option) not in (0, 1):
        raise RuntimeError('ComStatsim requires an ElmRes and a readable iopt_maint option.')
    clock = engine._capture_study_time(app)
    objects = engine._find_project_outages(app)
    outage_state = []
    for obj in objects:
        found, value = engine._read_setting(obj, 'outserv')
        if not found or engine.finite_number(value) not in (0, 1):
            raise RuntimeError('Cannot capture the ignored flag for planned outage ' + engine.object_name(obj))
        outage_state.append((obj, value))
    logger = engine.RunLogger(app)
    temporary_results = []; results = []; restore_errors = []
    # Keep every validated sample for the database. GridLens normally downsamples plots only.
    engine.MAX_PLOT_POINTS = engine.MAX_RESULT_ROWS
    engine.GRID_NAME_FILTER = GRID_NAME_FILTER
    try:
        for obj, _original in outage_state:
            ignored = 0 if identifier(engine.object_key(obj)) in requested else 1
            if not engine._set_scalar_attribute(obj, 'outserv', ignored):
                raise RuntimeError('Could not set the planned-outage selection for this scenario.')
        _records, candidates = engine.classify_planned_outages(app, logger, tuple(catalog['period']))
        if len(candidates) != len(requested):
            raise RuntimeError('PowerFactory outage discovery differs from the selected scenario.')
        windows = [record['window'] for record in candidates]
        for kind, option in [('REF', 0), ('OUTAGE', 1)]:
            if not engine._set_scalar_attribute(qds, engine.PLANNED_OUTAGE_OPTION, option):
                raise RuntimeError('Cannot verify ComStatsim.iopt_maint for ' + kind)
            results.append(engine._run_calculation(app, study_case, qds, kind,
                                                  job['payload']['name'] + ' · ' + kind,
                                                  'Named planned-outage scenario', original_result,
                                                  logger, temporary_results, windows))
            errors = engine._restore_study_time(clock, logger, 'CALCULATION', 4)
            if errors:
                raise RuntimeError('; '.join(errors))
        engine.check_run_budget(results)
        engine.enforce_common_time_axis(results)
        if any(result['status'] != engine.CONVERGED for result in results):
            raise RuntimeError('Reference and outage time axes differ; scenario results were rejected.')
        runs = [serialize_result(result, catalog['project_path'], tuple(catalog['period'])) for result in results]
    finally:
        for obj, original in reversed(outage_state):
            if not engine._set_scalar_attribute(obj, 'outserv', original):
                restore_errors.append('Planned outage ignored flag: ' + engine.object_name(obj))
        restore_errors.extend(engine._restore_study_time(clock, logger))
        restore_errors.extend(engine._restore_planned_outage_option(qds, original_option, logger))
        restore_errors.extend(engine._restore_results_binding(qds, original_result))
        restore_errors.extend(engine._delete_temporary_results(temporary_results, logger))
        if restore_errors:
            raise RuntimeError('PowerFactory state restoration failed. Results were not saved. Verify the Study Case manually: ' + '; '.join(restore_errors))
    return runs


def execute(app, database_path=DATABASE_PATH):
    store = ScenarioStore(str(database_path))
    job = None
    try:
        job = store.claim()
        catalog = discover(app)
        store.publish_catalog(catalog)
        if job is None:
            app.PrintPlain('[Nahriva] Planned outages synchronized. Create a named scenario in Outage Management and run this script again.')
            return
        if job['kind'] == 'sync':
            store.finish(job['id'], 'Planned outages synchronized.')
            job = None
        elif job['kind'] == 'run':
            runs = calculate(app, job, catalog)
            # Publish the restored state rather than the temporary outage selection.
            store.publish_catalog(discover(app))
            store.save_scenario(job, catalog, runs)
            name = job['payload']['name']
            job = None
            app.PrintPlain('[Nahriva] Saved scenario: ' + name)
        else:
            raise RuntimeError('Unsupported PowerFactory job kind.')
    except BaseException as exc:
        if job is not None:
            store.finish(job['id'], str(exc) or type(exc).__name__, failed=True)
        raise
    finally:
        store.close()


def main():
    import powerfactory
    app = powerfactory.GetApplication()
    if app is None:
        raise RuntimeError('Run this script from an active PowerFactory 2026 ComPython.')
    try:
        execute(app)
    except BaseException as exc:
        app.PrintPlain('[Nahriva][ERROR] ' + str(exc))
        raise


if __name__ == '__main__':
    main()
