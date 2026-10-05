"""Run as a ComPython external script in PowerFactory 2026.

Uses only the Python standard library and the native powerfactory module.
Each invocation synchronizes planned outages and handles one queued web request.

Cases
- REF:    every planned outage disabled (outserv=1) and the ComStatsim option 'Planned Outages' off.
- OUTAGE: only the planned outages of one scenario enabled, the option on; PowerFactory applies each
          one inside its own time window.
A batch (start_assessment.py) calculates REF once and passes it to every scenario.
"""
import hashlib
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
# Set this to the exact database displayed/configured in the web application.
DATABASE_PATH = PROJECT_DIR / 'backend/data/analysis.sqlite3'
GRID_NAME_FILTER = ''  # setting

sys.path.insert(0, str(PROJECT_DIR / 'backend'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import gridlens_engine as engine
import lodf
from pf_console import case, detail, log, table
import run_summary
from app.simulation.store import ScenarioStore, catalog_signature, outage_key


def identifier(path):
    return hashlib.sha256(path.encode('utf-8')).hexdigest()


REFERENCE_NAME = 'Reference · all planned outages disabled'


def discover(app, period=None):
    """Project, Study Case and planned outages. `period` (epoch seconds) replaces the period ComStatsim
    declares, e.g. the one a reference calculation actually covered."""
    project = app.GetActiveProject()
    study_case = app.GetActiveStudyCase()
    qds = app.GetFromStudyCase('ComStatsim')
    if project is None or study_case is None or qds is None:
        raise RuntimeError('Activate a project and a Study Case with configured ComStatsim first.')
    period = tuple(period) if period is not None else engine.qds_period(qds)
    # Native module reports the running PF build; never infer it from this script's target year.
    version = getattr(sys.modules.get('powerfactory'), '__version__', None)
    version = version.strip() if isinstance(version, str) and version.strip() else None
    try:
        operational_scenario = app.GetActiveScenario()
        scenario = ({'name': engine.object_name(operational_scenario),
                     'path': engine.object_key(operational_scenario)} if operational_scenario else None)
    except Exception:
        scenario = None
    try:
        networks = sorted(
            [{'name': engine.object_name(grid), 'path': engine.object_key(grid)}
             for grid in app.GetCalcRelevantObjects('*.ElmNet')], key=lambda grid: grid['path'])
    except Exception:
        networks = None
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
            'period': list(period), 'grid_name_filter': GRID_NAME_FILTER, 'outages': outages,
            'data_source': 'PowerFactory', 'powerfactory_version': version,
            'operational_scenario': scenario, 'networks': networks,
            'qds_command': {'name': engine.object_name(qds), 'path': engine.object_key(qds)},
            'captured_at': datetime.now(timezone.utc).isoformat()}


def compute_lodf(app, catalog, plan):
    """LODF of every outage of the plan, calculated before any simulation.

    Returns (rows, undefined): rows for ScenarioStore.save_lodf and {outage_key: reason} for the outages
    whose LODF is not defined (AC load flow without solution, equipment cut off). Failures are reported
    and yield no rows so the assessment itself still runs; the dashboard then shows no LODF.
    """
    engine.GRID_NAME_FILTER = GRID_NAME_FILTER
    by_id = {identifier(engine.object_key(o)): o for o in engine._find_project_outages(app)}
    unique = {}
    for selection in plan:  # scenarios with the same outages share one calculation
        key = outage_key(selection['outage_ids'])
        if key not in unique:
            unique[key] = {'key': key, 'name': selection['name'],
                           'equipment': list({engine.object_key(b): b for i in selection['outage_ids']
                                              if i in by_id for b in lodf.outage_equipment(by_id[i])}.values())}
    project_path = catalog['project_path']
    undefined = {}
    try:
        rows = lodf.calculate(app, list(unique.values()),
                              lambda branch: identifier(project_path + '|' + engine.object_key(branch)),
                              lambda message: detail(app, message), undefined)
    except lodf.LodfError as exc:
        detail(app, str(exc), 'WARN')
        return [], {}
    return rows, undefined


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
            metrics[code] = (code, 'Voltage' if code == 'voltage' else 'Loading', item['unit'], None, 100 if code == 'loading' else None)
            if code == 'voltage' and item.get('limits'):
                limits.append((element_id, code, *item['limits']))
            for _label, hours, value in item['points']:
                epoch = origin + (hours - relative_offset) * 3600
                if period[0] is not None and period[1] is not None and not period[0]-1 <= epoch <= period[1]+1:
                    raise RuntimeError('ElmRes timestamps lie outside the active QDS period.')
                # (element, metric, epoch seconds UTC, value); None: no valid value at that time.
                samples.append((element_id, code, int(round(epoch)), value))
    names = {'active_power': 'Active power', 'reactive_power': 'Reactive power', 'apparent_power': 'Apparent power',
             'current': 'Current', 'loading': 'Loading', 'voltage': 'Voltage'}
    for item in result.get('extras', []):
        if len(item['values']) != len(result['plot_times']):
            raise RuntimeError('Database export requires the complete ElmRes series, not plot downsampling.')
        element_id = identifier(project_path + '|' + item['key'])
        elements.setdefault(element_id, (element_id, item['element_name'], engine.class_name(item['object']),
                                          'bus' if item['category'] == 'voltage' else item['category'], item['key']))
        if item['metric'] not in metrics:
            metrics[item['metric']] = (item['metric'], names.get(item['metric'], item['variable_id']), item['unit'], None, None)
        for hours, value in zip(result['plot_times'], item['values']):
            samples.append((element_id, item['metric'], int(round(origin + (hours - relative_offset) * 3600)), value))
    status, note = run_state(result, samples, origin)
    return {'kind': result['id'], 'elements': list(elements.values()), 'metrics': list(metrics.values()), 'samples': samples,
            'limits': limits, 'status': status, 'note': note}


EXPECTED = {'ElmLne': 'line', 'ElmTr2': 'transformer', 'ElmTr3': 'transformer', 'ElmTerm': 'busbar'}


def stored_as(variable):
    """The name a variable of the result file gets in the database (and the dashboard's Measurement list)."""
    if variable in ('c:loading', 'm:loading'):
        return 'loading'
    if variable in ('m:u', 'm:u1'):
        return 'voltage'
    if variable.startswith('b:'):
        return 'not stored (calculation parameter)'
    return engine.STANDARD_METRICS.get(variable, (variable.replace(':', '_'), ''))[0] if engine.READ_ALL_VARIABLES else 'not stored'


def describe_columns(app, result):
    """What the result file (ElmRes) records, per class and variable, and what of it reaches the dashboard.

    Equipment or quantities missing in the dashboard are missing here: add them to the result variables of ComStatsim.
    """
    census = result.get('columns') or {}
    if not census:
        return
    detail(app, 'Result file content (variables recorded per class; everything stored here is offered in the dashboard):')
    table(app, ('Class', 'Variable', 'Columns', 'Stored as'),
          [(cls, variable, count, stored_as(variable)) for (cls, variable), count in sorted(census.items())])
    recorded = {cls for cls, _variable in census}
    for cls, noun in EXPECTED.items():
        if cls == 'ElmTr3' and cls not in recorded:
            continue  # three-winding transformers are rare
        needed = ('c:loading', 'm:loading') if noun != 'busbar' else ('m:u', 'm:u1')
        if not any(c == cls and v in needed for (c, v) in census):
            detail(app, "No {} ({}) {} in the result file: add {} to the result variables of ComStatsim to assess "
                        "them.".format(noun + 's', cls, 'loading' if noun != 'busbar' else 'voltage', needed[0]), 'WARN')


def run_state(result, samples, origin):
    """('completed' | 'not_converged' | 'incomplete', explanation) of a calculated run.

    not_converged: the calculation ended with an error code, the results stop there. incomplete: it ended
    normally, but at some time points no series has a value, which is what a load flow without solution leaves.
    """
    times = {}
    for _element, _metric, epoch, value in samples:
        times[epoch] = times.get(epoch, False) or value is not None
    empty = sorted(epoch for epoch, valid in times.items() if not valid)
    first, last = (min(times), max(times)) if times else (None, None)
    covered = '{} time points from {} to {}'.format(len(times), engine._format_pf_time(first), engine._format_pf_time(last)) if times else 'no time points'
    if result['status'] != engine.CONVERGED:
        return 'not_converged', '{} Results saved up to there: {}.'.format(result.get('message') or 'Did not converge.', covered)
    if empty:
        shown = ', '.join(engine._format_pf_time(epoch) for epoch in empty[:5]) + (' ...' if len(empty) > 5 else '')
        return 'incomplete', ('{} of {} time points have no valid value in any series (PowerFactory returned no result '
                              'there, typically a load flow without solution): {}.').format(len(empty), len(times), shown)
    return 'completed', ''


class CaseLogger(engine.RunLogger):
    """GridLens progress lines without one warning per planned outage that a case disables on purpose.

    REF disables every planned outage and each OUTAGE run all but its own; those are counted and
    listed with their names in the case header by _describe_case instead.
    """

    DISABLED = 'Outage object is disabled (outserv=1).'

    def __init__(self, app):
        super().__init__(app)
        self.disabled = 0

    def write(self, stage, message, step=None, level='INFO'):
        if stage == 'OUTAGES' and message.endswith(self.DISABLED):
            self.disabled += 1
            return
        super().write(stage, message, step, level)


def _span(start, end):
    return engine._format_pf_time(start) + ' to ' + engine._format_pf_time(end)


def _describe_case(app, kind, records, candidates, option, period):
    """Everything about one case at a glance: what is enabled, what is disabled, how PowerFactory is set."""
    disabled = [r for r in records if r['status'] == engine.OUTAGE_SKIPPED and r['skip_reason'] == CaseLogger.DISABLED]
    detail(app, "ComStatsim option 'Planned Outages': {} | QDS period {}".format('on' if option else 'off', _span(*period)))
    if candidates:
        detail(app, 'Planned outages enabled ({}); PowerFactory switches the equipment off inside the window and keeps '
                    'it in service before and after:'.format(len(candidates)))
        table(app, ('Planned outage', 'Active', 'Equipment'),
              [(r['name'], _span(*r['window']), r['equipment_name'] or 'none found') for r in candidates])
    else:
        detail(app, 'Planned outages enabled: none (reference case)')
    detail(app, 'Planned outages disabled ({}): {}'.format(len(disabled), ', '.join(r['name'] for r in disabled) or 'none'))


def _run_cases(app, catalog, cases):
    """Calculate `cases` [(kind, name, enabled outage ids, 'Planned Outages' option)] one after another.

    Every planned outage not in `enabled` is disabled for the case. Whatever happens, the ignored flags,
    the option, the result binding and the Study Case time are restored and the temporary results are
    deleted; a restoration failure raises so that nothing is saved on top of an unknown state.
    """
    study_case = app.GetActiveStudyCase()
    qds = app.GetFromStudyCase('ComStatsim')
    original_result = engine.safe_attr(qds, 'results')
    found, original_option = engine._read_setting(qds, engine.PLANNED_OUTAGE_OPTION)
    where = "ComStatsim '{}' of Study Case '{}'".format(engine.object_name(qds), engine.object_name(study_case))
    if original_result is None:
        raise RuntimeError(
            where + " has no result file: ComStatsim.results is empty. Typical cause: an earlier run was cut off "
            "while its temporary result was bound, and PowerFactory deleted it. Open the ComStatsim dialog, set "
            "'Results' to your ElmRes (with the loading and voltage variables selected) and run again.")
    if not found or engine.finite_number(original_option) not in (0, 1):
        raise RuntimeError(
            where + " does not give a usable 'Planned Outages' option ({}): it reads {!r}, expected 0 or 1. "
            "Open the ComStatsim dialog and check the option 'Planned Outages'.".format(
                engine.PLANNED_OUTAGE_OPTION, original_option if found else 'unreadable'))
    if engine.object_name(original_result).startswith(engine.SNAPSHOT_PREFIX + 'TMP_'):
        detail(app, "ComStatsim.results is bound to '{}', a temporary result left behind by an earlier run that was "
                    "cut off. It is used as the configured result file and the binding is restored afterwards; "
                    "bind ComStatsim.results to your own ElmRes to tidy up.".format(engine.object_name(original_result)), 'WARN')
    clock = engine._capture_study_time(app)
    outage_state = []
    for obj in engine._find_project_outages(app):
        found, value = engine._read_setting(obj, 'outserv')
        if not found or engine.finite_number(value) not in (0, 1):
            raise RuntimeError('Cannot capture the ignored flag for planned outage ' + engine.object_name(obj))
        outage_state.append((obj, value))
    logger = CaseLogger(app)
    temporary_results = []; results = []; restore_errors = []
    # Keep every validated sample for the database. GridLens normally downsamples plots only.
    engine.MAX_PLOT_POINTS = engine.MAX_RESULT_ROWS
    engine.GRID_NAME_FILTER = GRID_NAME_FILTER
    try:
        for kind, name, enabled, option in cases:
            for obj, _original in outage_state:
                ignored = 0 if identifier(engine.object_key(obj)) in enabled else 1
                if not engine._set_scalar_attribute(obj, 'outserv', ignored):
                    raise RuntimeError('Could not set the planned-outage selection for ' + kind + '.')
            suffix = ' · ' + kind  # the name of a scenario case ends with its kind: "NE_L1 · OUTAGE"
            case(app, 'Case {} · {}'.format(kind, name[:-len(suffix)] if name.endswith(suffix) else name))
            logger.disabled = 0
            records, candidates = engine.classify_planned_outages(app, logger, tuple(catalog['period']))
            if len(candidates) != len(enabled):
                raise RuntimeError('PowerFactory outage discovery differs from the selection for ' + kind + '.')
            if not engine._set_scalar_attribute(qds, engine.PLANNED_OUTAGE_OPTION, option):
                raise RuntimeError('Cannot verify ComStatsim.iopt_maint for ' + kind)
            _describe_case(app, kind, records, candidates, option, catalog['period'])
            results.append(engine._run_calculation(app, study_case, qds, kind, name,
                                                  'Named planned-outage scenario', original_result,
                                                  logger, temporary_results,
                                                  [record['window'] for record in candidates]))
            if kind == 'REF':
                describe_columns(app, results[-1])
            errors = engine._restore_study_time(clock, logger, 'CALCULATION', 4)
            if errors:
                raise RuntimeError('; '.join(errors))
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
    return results


def calculate_reference(app, catalog):
    """REF once for a whole batch: every planned outage disabled. Shared by all scenarios of the batch.

    A REF that did not converge is returned too (status NOT CONVERGED) so that its results can be saved and looked at;
    the caller stops the assessment, because without a reference no scenario can be compared.
    """
    reference = _run_cases(app, catalog, [('REF', REFERENCE_NAME, set(), 0)])[0]
    reference['shared_run_id'] = 'reference-' + uuid.uuid4().hex
    return reference


def simulated_period(reference, declared):
    """The period PowerFactory actually calculated (epoch seconds), or the declared one for a relative axis.

    ComStatsim may declare a longer period than it simulates, e.g. with 'Time period' set to one month
    around the Study Case time; outage windows must be compared with what is in the results.
    """
    start, end = reference['window']
    return (round(start), round(end)) if start is not None and end is not None else tuple(declared)


def shared_reference(reference, project_path, period):
    run = reference.get('_serialized')
    if run is None:
        run = serialize_result(reference, project_path, period)
        run.update(run_id=reference['shared_run_id'], name=REFERENCE_NAME, shared=True)
        reference['_serialized'] = run
    return run


def calculate(app, job, catalog, reference=None):
    """REF and OUTAGE runs of one scenario, ready for ScenarioStore.save_scenario.

    With `reference` (from calculate_reference) only OUTAGE is calculated and REF is linked, not copied.
    """
    if job['payload']['catalog_signature'] != catalog_signature(catalog):
        raise RuntimeError('PowerFactory project, Study Case, QDS period or planned outages changed since the request. Synchronize and submit again.')
    requested = set(job['payload']['outage_ids'])
    allowed = {o['id'] for o in catalog['outages'] if o['in_period']}
    if not requested or not requested <= allowed:
        raise RuntimeError('The scenario contains unknown outages or outages outside the QDS period.')
    name = job['payload']['name']
    cases = [('OUTAGE', name + ' · OUTAGE', requested, 1)]
    if reference is None:
        cases.insert(0, ('REF', name + ' · REF', set(), 0))
    results = ([reference] if reference is not None else []) + _run_cases(app, catalog, cases)
    engine.check_run_budget(results)
    engine.enforce_common_time_axis(results)
    if any(result['status'] not in (engine.CONVERGED, engine.NOT_CONVERGED) for result in results):
        raise RuntimeError('Reference and outage time axes differ; scenario results were rejected.')
    period = tuple(catalog['period'])
    if reference is None:
        return [serialize_result(result, catalog['project_path'], period) for result in results]
    return [shared_reference(reference, catalog['project_path'], period),
            serialize_result(results[1], catalog['project_path'], period)]


def prepare_dashboard(app, store, scenario_id):
    """Reduce the saved scenario once for the dashboard, so its first view needs no pass over millions of values.

    Optional: without it the dashboard reduces the scenario itself on first view. It never stops the assessment.
    """
    started = time.monotonic()
    try:
        from app.simulation import across
        across.prepare_cells(store, scenario_id)
    except Exception as exc:
        detail(app, 'Dashboard summary not prepared ({}); the dashboard calculates it on first view.'.format(exc), 'WARN')
        return
    detail(app, 'Dashboard summary prepared in {:.1f} s.'.format(time.monotonic() - started))


def execute(app, database_path=DATABASE_PATH, reference=None, period=None):
    """Handle one queued job. A batch passes its shared `reference` and the `period` it covered.

    Returns {'name', 'summary'} of the scenario that was saved, None for a job that only synchronised.
    """
    store = ScenarioStore(str(database_path))
    job = None
    try:
        job = store.claim()
        catalog = discover(app, period)
        store.publish_catalog(catalog)
        if job is None:
            log(app, 'Planned outages synchronized. Create a named scenario in Outage Management and run this script again.')
            return
        if job['kind'] == 'sync':
            store.finish(job['id'], 'Planned outages synchronized.')
            job = None
        elif job['kind'] == 'run':
            job_ids = job['payload']['outage_ids']
            runs = calculate(app, job, catalog, reference)
            # Publish the restored state rather than the temporary outage selection.
            store.publish_catalog(discover(app, period))
            store.save_scenario(job, catalog, runs)
            prepare_dashboard(app, store, job['id'])
            name = job['payload']['name']
            job = None
            outages = {o['id']: o for o in catalog['outages']}
            windows = [(outages[i]['start'], outages[i]['end']) for i in job_ids if i in outages]
            log(app, "Saved scenario '" + name + "'.")
            summary = run_summary.describe(runs, windows)
            if summary:
                detail(app, 'Result ' + summary + '.')
            flagged = [run for run in runs if run.get('status', 'completed') != 'completed' and not run.get('shared')]
            for run in flagged:
                detail(app, "{} saved with state '{}': {}".format(run['kind'], run['status'].replace('_', ' '), run['note']), 'WARN')
            return {'name': name, 'summary': summary, 'status': flagged[0]['status'] if flagged else 'completed',
                    'note': flagged[0]['note'] if flagged else ''}
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
        log(app, str(exc) or type(exc).__name__, 'ERROR')
        raise


if __name__ == '__main__':
    main()
