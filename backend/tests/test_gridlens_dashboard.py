"""GridLens GUI/calculation handoff and raw widget data, without PowerFactory."""

import copy
import importlib.util
import json
import sys
from pathlib import Path
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'powerfactory'))
sys.path.insert(0, str(ROOT / 'scripts'))

import gridlens_dashboard as bridge
import gridlens_runtime as gl
from app.simulation import gridlens_store as raw
from app.simulation import settings
from app.simulation.store import ScenarioStore
from tests.gridlens_fixture import App, ElmRes, PFObject, PlannedOutage, PERIOD_START


class Result(ElmRes):
    """A QDS result with a relative hour axis; a kept copy covers the period the ComStatsim was set to."""

    def __init__(self, rows=301, qds=None):
        super().__init__()
        self.qds = qds
        self._fill(rows)

    def _fill(self, rows):
        self.columns = ([index / 4 for index in range(rows)], [90.0] * rows, [1.0] * rows, [0.0] * rows)

    def GetNumberOfRows(self):
        return len(self.columns[0])

    def clone(self):
        kept = copy.copy(self)
        if self.qds is not None:
            step = self.qds.stepSize * gl.STEP_UNIT_SECONDS[self.qds.stepUnit]
            kept._fill(int((self.qds.endTime - self.qds.startTime) // step))
        return kept


# The planned outages of the fixture span 75 h: main.py sets the QDS period to them, 301 quarter hours.
WINDOW_END = PERIOD_START + 75 * 3600


@pytest.fixture
def native(tmp_path, monkeypatch):
    app = App([PlannedOutage('Chosen', endtime=WINDOW_END), PlannedOutage('Other', disabled=True, endtime=WINDOW_END)])
    app.qds.results = app.original_result = Result(qds=app.qds)
    app.qds.stepSize, app.qds.stepUnit = 15, 1
    monkeypatch.setattr(gl, 'CASE_SOURCE', 'gui')
    monkeypatch.setattr(gl, 'CASE_CONFIG_DIR', str(tmp_path / 'cases'))
    monkeypatch.setattr(gl, 'GRID_NAME_FILTER', '')
    for name in ('build_cases_payload', 'publish_report'):
        monkeypatch.setattr(gl, name, lambda *a, **k: pytest.fail('Report tables must never be built or published'))

    def gui(records, *_args, **_kwargs):
        config = gl.empty_case_config()
        config['cases'] = [{'id': 'C1', 'name': 'Both outages', 'outages': [record['key'] for record in records]}]
        return config
    monkeypatch.setattr(gl, 'run_case_manager', gui)
    return app, tmp_path / 'native.sqlite3'


def test_gui_and_native_qds_then_import_and_original_evaluation_without_report(native):
    app, path = native
    outcome = bridge.run_assessment(app, path)
    assert app.qds.execute_calls == 2
    assert app.qds.outage_options == [0, 1]
    assert set(app.qds.active_outages[1]) == {'Chosen', 'Other'}
    assert [outage.outserv for outage in app.outages] == [0, 1]
    assert app.qds.iopt_maint == 0
    assert app.study_time.cDate == 20140501 and app.study_time.cTime == 0
    assert app.report.reset_calls == 0
    assert len(app.study.copies) == 2 and all(not result.deleted for result in app.study.copies)
    store = ScenarioStore(path)
    try:
        assessment = raw.assessment(store.db, outcome['assessment_id'])
        assert assessment['engine_version'] == gl.PUBLISHER_VERSION
        assert len(assessment['results']) == 2
        assert store.db.execute('SELECT SUM(rows) FROM pf_run_values').fetchone()[0] == 301 * 3 * 2
        assert store.db.execute('SELECT COUNT(*) FROM analysis_values').fetchone()[0] == 0  # values live in Parquet
        assert store.db.execute('SELECT COUNT(*) FROM pf_lodf').fetchone()[0] == 0
        assert store.db.execute('SELECT COUNT(*) FROM pf_scenario_cells').fetchone()[0] == 1
        scenario = store.overview()['scenarios'][0]
        assert {run['kind'] for run in scenario['runs']} == {'REF', 'OUTAGE'}
        for result in assessment['results']:
            assert result['native_path'].endswith('.ElmRes')
            column = raw.columns(store.db, result['id'])[0]
            points = raw.series(store.db, result['id'], column['column_id'], '')
            assert len(points) == 301
            assert points[0]['timestamp'] == PERIOD_START
    finally:
        store.close()


def test_cancel_calculates_nothing_and_does_not_import(native, monkeypatch):
    app, path = native
    monkeypatch.setattr(gl, 'run_case_manager', lambda *a, **k: None)
    with pytest.raises(gl.OutageAssessmentCancelled):
        bridge.run_assessment(app, path)
    assert app.qds.execute_calls == 0 and not path.exists()


def test_reference_failure_restores_and_leaves_no_database(native):
    app, path = native
    app.qds.failure = RuntimeError('native failure')
    with pytest.raises(gl.OutageAssessmentError, match='failed'):
        bridge.run_assessment(app, path)
    assert [outage.outserv for outage in app.outages] == [0, 1]
    assert app.qds.iopt_maint == 0 and app.study_time.cDate == 20140501
    assert not path.exists()


class Sub(PFObject):
    def __init__(self, moment, faults, values):
        super().__init__('sub', 'ElmRes', cnttime=moment)
        self.faults, self.values = faults, values
        self.owner = PFObject('Line A', 'ElmLne')  # the line the QDS result records too

    def Load(self):
        pass

    def Release(self):
        pass

    def GetNumberOfRows(self):
        return len(self.faults)

    def GetNumberOfColumns(self):
        return 1

    def GetObject(self, _column):
        return self.owner

    def GetVariable(self, _column):
        return 'c:loading'

    def GetUnit(self, _column):
        return '%'

    def GetObjectValue(self, row):
        return 0, self.faults[row]

    def GetValue(self, row, _column):
        return self.values[row]


class Sweep(PFObject):
    def __init__(self, children):
        super().__init__('Kept N1', 'ElmRes')
        self.children = children

    def GetContents(self, *_args):
        return self.children

    def clone(self):
        return copy.copy(self)


def test_sparse_codes_missing_rows_read_errors_and_zero_are_distinct(native, monkeypatch):
    app, path = native
    fault = PFObject('Fault', 'ComOutage')
    fault_key = gl.object_key(fault)
    sweep = Sweep([
        Sub(PERIOD_START, [fault], [(3, 0.0)]),
        Sub(PERIOD_START + 900, [fault], [(0, 0.0)]),
        Sub(PERIOD_START + 1800, [fault], [(7, 0.0)]),
        Sub(PERIOD_START + 2700, [], []),
    ])

    def calculate(*_args):
        return {'C1': {'status': 'CALCULATED', 'kind': gl.N1_PRIME,
                       'elements_of': {fault_key: set()},
                       'reference': {'kept': sweep, 'window_times': [PERIOD_START, PERIOD_START + 3600],
                                     'recording_limits': {'loading': (80.0,)}}, 'scenario': None}}
    original = gl.run_case_manager

    def gui(*args, **kwargs):
        config = original(*args, **kwargs)
        config['assessments'] = ['n-0', gl.N1_REFERENCE]
        return config
    monkeypatch.setattr(gl, 'run_case_manager', gui)
    monkeypatch.setattr(gl, 'calculate_n1', calculate)
    outcome = bridge.run_assessment(app, path)
    store = ScenarioStore(path)
    try:
        native_result = next(result for result in raw.assessment(store.db, outcome['assessment_id'])['results'] if result['kind'] == 'n-1')
        cid = raw.contingencies(store.db, native_result['id'])[0]['id']
        points = raw.series(store.db, native_result['id'], 0, cid)
        assert [(p['state'], p['value'], p['code']) for p in points] == [
            ('not_recorded', None, 3), ('value', 0.0, 0), ('read_error', None, 7), ('missing_row', None, None)]
        assert native_result['metadata']['missing_times'] == [PERIOD_START + 3600]
        assert native_result['status'] == 'incomplete'
        assert store.db.execute('SELECT COUNT(*) FROM gl_values WHERE result_id=?', (native_result['id'],)).fetchone()[0] == 2
    finally:
        store.close()


def test_widget_api_reads_full_series_and_validates_pagination(native, monkeypatch):
    app, path = native
    outcome = bridge.run_assessment(app, path)
    monkeypatch.setattr(settings, 'ANALYSIS_DB_PATH', str(path))
    monkeypatch.setattr(settings, 'ANALYSIS_MODE', 'sqlite')
    from app.main import app as webapp
    with TestClient(webapp) as client:
        assert client.get('/api/simulation/gridlens/assessments').json()['assessments'][0]['id'] == outcome['assessment_id']
        item = client.get('/api/simulation/gridlens/assessments/' + outcome['assessment_id']).json()
        result = item['results'][0]
        root = '/api/simulation/gridlens/results/' + result['id']
        column = client.get(root + '/columns').json()['columns'][0]
        first = client.get(root + '/series', params={'column_id': column['column_id'], 'limit': 200}).json()
        second = client.get(root + '/series', params={'column_id': column['column_id'], 'offset': 200}).json()
        assert len(first['points']) == 200 and len(second['points']) == 101
        assert first['points'][-1]['timestamp'] < second['points'][0]['timestamp']
        assert client.get(root + '/series', params={'column_id': 999}).status_code == 404
        assert client.get(root + '/series', params={'column_id': 1, 'limit': 99999}).status_code == 422
        assert client.get(root + '/series', params={'column_id': 1, 'start': 2, 'end': 1}).status_code == 422
        # The original dashboard contracts still serve the newly calculated QDS data.
        assert len(client.get('/api/simulation/facilities').json()) == 2
        assert len(client.get('/api/simulation/across-scenarios/index').json()['scenarios']) == 1


def test_failed_import_keeps_stored_runs_marks_missing_cases_and_keeps_native_results(native, monkeypatch):
    app, path = native
    original = bridge._read_qds
    calls = []

    def fail(*args):
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError('storage failed')
        return original(*args)
    monkeypatch.setattr(bridge, '_read_qds', fail)
    saved = []
    with pytest.raises(RuntimeError, match='storage failed'):
        bridge.run_assessment(app, path, lambda *args: saved.append(args))
    store = ScenarioStore(path)
    # REF was committed before the case failed; nothing of the failed case is visible.
    assert saved == [(1, 2, 'QDS REF', 0)]
    assert store.db.execute('SELECT COUNT(*) FROM analysis_runs').fetchone()[0] == 1
    assert store.overview()['scenarios'] == []
    [assessment] = raw.assessments(store.db)
    case = store.db.execute('SELECT status, reason FROM gl_cases WHERE assessment_id=?', (assessment['id'],)).fetchone()
    assert case['status'] == 'IMPORT FAILED' and 'storage failed' in case['reason']
    store.close()
    assert len(app.study.copies) == 2 and all(not result.deleted for result in app.study.copies)


def test_cases_are_listed_one_by_one_while_the_import_continues(native, monkeypatch):
    app, path = native
    original = gl.run_case_manager

    def gui(*args, **kwargs):
        config = original(*args, **kwargs)
        config['cases'].append({'id': 'C2', 'name': 'Only chosen', 'outages': [config['cases'][0]['outages'][0]]})
        return config
    monkeypatch.setattr(gl, 'run_case_manager', gui)
    listed = []

    def saved(done, total, detail, scenarios):
        store = ScenarioStore(path)
        try:
            listed.append((detail, scenarios, len(store.overview()['scenarios'])))
        finally:
            store.close()
    bridge.run_assessment(app, path, saved)
    # Another connection (the dashboard) sees every case as soon as it is stored.
    assert listed == [('QDS REF', 0, 0), ('QDS C1', 1, 1), ('QDS C2', 2, 2)]


def test_starter_starts_dashboard_early_shows_it_after_the_first_case_and_never_on_cancel(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location('gridlens_starter', ROOT / 'powerfactory/start_assessment.py')
    starter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(starter)
    monkeypatch.setattr(starter, 'prepare_imports', lambda: None)
    monkeypatch.setattr(starter, 'ensure_installation', lambda app: None)
    monkeypatch.setattr(starter, 'preflight', lambda database: 50.0)
    monkeypatch.setattr(gl, 'load_qt', lambda: None)
    monkeypatch.setenv('OA_DATABASE', str(tmp_path / 'starter.sqlite3'))
    monkeypatch.setitem(sys.modules, 'powerfactory', type('PF', (), {'GetApplication': staticmethod(lambda: App())}))
    import dashboard_launcher
    order = []
    monkeypatch.setattr(dashboard_launcher, 'validate_installation', lambda *a: None)
    monkeypatch.setattr(dashboard_launcher, 'start_dashboard', lambda *a, **k: order.append('start') or {'port': 8765})
    monkeypatch.setattr(dashboard_launcher, 'wait_for_dashboard',
                        lambda *a, **k: order.append('show') or {'url': 'http://127.0.0.1:8765', 'lan_urls': [], 'notes': []})
    monkeypatch.setattr(dashboard_launcher, 'stop_started_dashboard', lambda *a: order.append('stop'))

    def calculate(app, database, on_saved):
        order.append('calculate')
        on_saved(1, 3, 'QDS REF', 0)
        on_saved(2, 3, 'QDS C1', 1)
        order.append('rest of the import')
        on_saved(3, 3, 'QDS C2', 2)
        return {'cases': 2, 'assessment_id': 'run'}
    monkeypatch.setattr(starter, 'run_assessment', calculate)
    assert starter.main()['url'] == 'http://127.0.0.1:8765'
    assert order == ['start', 'calculate', 'show', 'rest of the import']
    order.clear()
    monkeypatch.setattr(starter, 'run_assessment', lambda *a: (_ for _ in ()).throw(gl.OutageAssessmentCancelled('cancelled')))
    assert starter.main() is None
    assert order == ['start', 'stop']


def test_reused_cases_keep_widget_series_and_kept_runs_do_not_recalculate(native, monkeypatch):
    app, path = native
    original = gl.run_case_manager

    def gui(*args, **kwargs):
        config = original(*args, **kwargs)
        config['cases'].append(dict(config['cases'][0], id='C2', name='Independent copy'))
        return config
    monkeypatch.setattr(gl, 'run_case_manager', gui)
    first = bridge.run_assessment(app, path)
    assert app.qds.execute_calls == 2
    store = ScenarioStore(path)
    details = raw.assessment(store.db, first['assessment_id'])
    assert len(details['results']) == 3
    alias = next(result for result in details['results'] if result['case_id'] == 'C2')
    assert len(raw.series(store.db, alias['id'], raw.columns(store.db, alias['id'])[0]['column_id'], '')) == 301
    store.close()

    def kept(*args, **kwargs):
        records, config, period, config_path = args[:4]
        editor = gl.CaseEditor(records, gui(*args, **kwargs), period, kept=[first['native_run_id']])
        editor.set_evaluate_stamp(first['native_run_id'])
        return dict(editor.config, evaluate_stamp=first['native_run_id'])
    # The normal dialog returns a config and obtain_case_request reads the selected stamp from it.
    monkeypatch.setattr(gl, 'run_case_manager', kept)
    second = bridge.run_assessment(app, path)
    assert second['native_run_id'] == first['native_run_id']
    assert app.qds.execute_calls == 2


@pytest.mark.parametrize('n0', [True, False])
def test_native_n1_and_n1_prime_run_and_restore_before_raw_import(native, monkeypatch, n0):
    app, path = native
    selected, other = app.outages
    selected.starttime, selected.endtime = PERIOD_START, PERIOD_START + 3600
    switched = PFObject('Outaged line', 'ElmLne')
    selected.components = [switched]
    kept_fault = PFObject('Monitored fault', 'ComOutage', outserv=0)
    off_fault = PFObject('Already outaged fault', 'ComOutage', outserv=0)
    kept_fault.GetObject = lambda index: PFObject('Other line', 'ElmLne') if index == 0 else None
    off_fault.GetObject = lambda index: switched if index == 0 else None

    class Analysis(PFObject):
        def __init__(self):
            super().__init__('Native CA', 'ComSimoutage', isPlannedOutages=1, loadmax=80.0,
                             vlmin=0.95, vlmax=1.05, calcPeriod=4, startTime=0, endTime=1,
                             stepSize=1, stepUnit=2, stepNumber=1, iEnableTS=1)
            self.calls = []
            self.p_rescnt = Sweep([])

        def GetContents(self, pattern='*'):
            return [kept_fault, off_fault] if pattern in ('*', '*.ComOutage') else []

        def Execute(self):
            step = self.stepSize * gl.STEP_UNIT_SECONDS[self.stepUnit]
            times = list(range(self.startTime, self.endTime, int(step)))
            self.calls.append((self.isPlannedOutages, times, selected.outserv, other.outserv))
            faults = [kept_fault] if self.isPlannedOutages else [kept_fault, off_fault]
            self.p_rescnt = Sweep([Sub(t, faults, [(0, 110.0 if self.isPlannedOutages else 90.0)] * len(faults)) for t in times])
            return 0

    if not n0:
        get = app.GetFromStudyCase
        app.GetFromStudyCase = lambda name: None if name == 'ComStatsim' else get(name)
    ca = Analysis()
    monkeypatch.setattr(gl, '_n1_command', lambda *args: (ca, None))
    contents = app.study.GetContents
    app.study.GetContents = lambda pattern='*', *args: [ca] if pattern == '*.ComSimoutage' else contents(pattern, *args)

    def gui(records, *_args, **_kwargs):
        config = gl.empty_case_config()
        config['assessments'] = (['n-0'] if n0 else []) + ['n-1', "(n-1)'"]
        config['cases'] = [{'id': 'C1', 'name': 'Native sweeps', 'outages': [record['key'] for record in records if record['name'] == 'Chosen']}]
        return config
    monkeypatch.setattr(gl, 'run_case_manager', gui)
    outcome = bridge.run_assessment(app, path)
    expected_times = [PERIOD_START + index * 900 for index in range(4)] if n0 else [PERIOD_START]
    assert app.qds.execute_calls == (2 if n0 else 0)
    assert ca.calls[0][0:2] == (0, expected_times)
    assert ca.calls[1] == (1, expected_times, 0, 1)
    assert (ca.isPlannedOutages, ca.startTime, ca.endTime, ca.stepSize, ca.stepUnit, ca.stepNumber) == (1, 0, 1, 1, 2, 1)
    assert [outage.outserv for outage in app.outages] == [0, 1]
    store = ScenarioStore(path)
    details = raw.assessment(store.db, outcome['assessment_id'])
    assert {result['kind'] for result in details['results']} == ({'QDS'} if n0 else set()) | {'n-1', "(n-1)'"}
    assert details['evaluations']['C1']['n1']['status'] == 'EVALUATED'
    assert len(store.overview()['scenarios']) == 1
    n1, prime = [next(result for result in details['results'] if result['kind'] == kind) for kind in ('n-1', "(n-1)'")]
    assert len(raw.contingencies(store.db, n1['id'])) == len(raw.contingencies(store.db, prime['id'])) == 2
    cid = bridge.identifier(gl.object_key(off_fault))
    assert all(point['state'] == 'missing_row' for point in raw.series(store.db, prime['id'], 0, cid))
    assert store.db.execute('SELECT COUNT(*) FROM pf_lodf').fetchone()[0] == 0
    store.close()
    # The n-1 pairs: which contingency overloads which branch, before (the QDS of C1) and after.
    monkeypatch.setattr(settings, 'ANALYSIS_DB_PATH', str(path))
    monkeypatch.setattr(settings, 'ANALYSIS_MODE', 'sqlite')
    from app.main import app as web
    with TestClient(web) as client:
        index = client.get('/api/simulation/gridlens/sweeps', params={'analysis': outcome['assessment_id']}).json()
        assert index['analysis'] == outcome['assessment_id']
        assert index['scenarios'][0]['case_id'] == 'C1'
        assert {r['kind'] for r in index['scenarios'][0]['sweeps']} == {'n-1', "(n-1)'"}
        if not n0:
            assert client.get('/api/simulation/across-scenarios/index', params={'analysis': outcome['assessment_id']}).json()['scenarios'] == []
        assert client.get('/api/simulation/gridlens/sweeps', params={'analysis': 'another-calculation'}).json()['scenarios'] == []
        url = '/api/simulation/scenarios/{}-C1/n1-pairs'.format(outcome['assessment_id'])
        # (n-1)': 110 % after 'Monitored fault' at every study time; before it the QDS of C1 (90 %).
        [pair] = client.get(url).json()['pairs']
        assert (pair['contingency'], pair['post'], pair['pre'], pair['limit']) == ('Monitored fault', 110.0, 90.0 if n0 else None, 100.0)
        assert pair['hours_over'] == 1 and pair['t'] in expected_times
        # n-1 stays below the limit: no pair.
        assert client.get(url, params={'kind': 'n-1'}).json()['total_pairs'] == 0
        source = client.get('/api/simulation/gridlens/assessments/' + outcome['assessment_id']).json()
        assert source['evaluations']['C1']['n1']['status'] == 'EVALUATED'
        response = client.get('/api/simulation/gridlens/results/' + prime['id'] + '/extremes')
        assert response.status_code == 200
        assert response.json()['rows'][0]['high'] == 110.0
        assert client.get('/api/simulation/gridlens/results/' + prime['id'] + '/extremes', params={'limit': 0}).status_code == 422


def test_original_verdict_and_episodes_survive_import_and_archive(native, monkeypatch, tmp_path):
    app, path = native
    clone = Result.clone

    def outage_clone(result):
        kept = clone(result)
        if result.qds.iopt_maint:
            kept.columns = (kept.columns[0], [110.0] * len(kept.columns[0]), *kept.columns[2:])
        return kept

    monkeypatch.setattr(Result, 'clone', outage_clone)
    outcome = bridge.run_assessment(app, path)
    with closing(ScenarioStore(path)) as store:
        evaluation = raw.assessment(store.db, outcome['assessment_id'])['evaluations']['C1']
        assert evaluation['n0']['assessment'] == gl.ASSESSMENT_LOADING
        assert evaluation['episodes'][0]['element_name'] == 'Line A'
        assert evaluation['episodes'][0]['peak_text'] == '110.0 %'
    from app.archive.parquet import export_analysis, import_analysis
    archive = tmp_path / 'archive'
    archive = export_analysis(path, outcome['assessment_id'], archive)
    restored = tmp_path / 'restored.sqlite3'
    import_analysis(archive, restored)
    with closing(ScenarioStore(restored)) as store:
        assert raw.assessment(store.db, outcome['assessment_id'])['evaluations']['C1'] == evaluation


def test_evaluation_failure_keeps_native_results_and_reports_failure(native, monkeypatch):
    app, path = native

    def fail(*args):
        raise RuntimeError('Evaluation failed deliberately')

    monkeypatch.setattr(gl, 'evaluate_runs', fail)
    with pytest.raises(RuntimeError, match='Evaluation failed deliberately'):
        bridge.run_assessment(app, path)
    with closing(ScenarioStore(path)) as store:
        assessment = raw.assessments(store.db)[0]
        assert assessment['status'] == 'evaluation_failed'
        detail = raw.assessment(store.db, assessment['id'])
        assert len(detail['results']) == 2
        assert detail['evaluations']['C1'] == {'status': 'failed', 'reason': 'Evaluation failed deliberately'}
        assert app.qds.iopt_maint == 0


def test_import_owner_is_held_until_original_evaluation_finishes(native, monkeypatch):
    app, path = native
    from app.simulation import imports
    evaluate = gl.evaluate_runs

    def evaluate_while_owned(*args):
        with pytest.raises(imports.ImportBusy):
            with imports.serialized(path):
                pytest.fail('Another import must not recover an active evaluation.')
        return evaluate(*args)

    monkeypatch.setattr(gl, 'evaluate_runs', evaluate_while_owned)
    bridge.run_assessment(app, path)
    with imports.serialized(path):
        pass


@pytest.mark.parametrize('form', ['pair', 'direct', 'index', 'axis_index', 'legacy', 'default_axis'])
def test_contingency_identity_supports_documented_axis_and_object_index(form):
    fault = PFObject('Fault A', 'ComOutage')

    class NativeAxis:
        def GetObjectValue(self, row, *column):
            assert row == 4
            if form == 'legacy' and column:
                raise TypeError('only one argument')
            if form == 'default_axis' and column:
                return 2, None
            if form in ('legacy', 'default_axis', 'pair'):
                return 0, fault
            if form == 'direct':
                return fault
            return (0, -7) if form == 'index' else (3, None)

        def GetValue(self, row, column):
            assert column == -1  # Never treat a monitored loading value as the row axis.
            return 0, -7

        def GetObj(self, index):
            assert index == -7  # No row-number, sign or off-by-one guesses.
            return fault

    found, _diagnostic = gl.contingency_row_object(NativeAxis(), 4)
    assert found is fault


def test_calculation_name_groups_cases_and_survives_archive(native, monkeypatch, tmp_path):
    app, path = native
    original = gl.run_case_manager
    name = 'Winterplanung – Nord'

    def gui(*args, **kwargs):
        config = original(*args, **kwargs)
        config['analysis_name'] = name
        return config

    monkeypatch.setattr(gl, 'run_case_manager', gui)
    first = bridge.run_assessment(app, path)
    name = 'Sommerplanung – Süd'
    second = bridge.run_assessment(app, path)
    with closing(ScenarioStore(path)) as store:
        assert raw.assessment(store.db, first['assessment_id'])['name'] == 'Winterplanung – Nord'
        assert raw.assessment(store.db, second['assessment_id'])['name'] == 'Sommerplanung – Süd'
        from app.simulation import across, compare
        assert {item['name'] for item in across.analyses(store.db)} == {'Winterplanung – Nord', 'Sommerplanung – Süd'}
        assert compare._analysis(store.db, first['assessment_id'])['name'] == 'Winterplanung – Nord'
        assert raw.assessment(store.db, first['assessment_id'])['cases'][0]['case_id'] == 'C1'
    from app.archive.parquet import export_analysis, import_analysis
    archive = export_analysis(path, first['assessment_id'], tmp_path / 'archives')
    restored = tmp_path / 'named.sqlite3'
    import_analysis(archive, restored)
    with closing(ScenarioStore(restored)) as store:
        assert raw.assessment(store.db, first['assessment_id'])['name'] == 'Winterplanung – Nord'


def test_unresolved_contingency_rows_are_retained_without_inventing_identity(native, monkeypatch, tmp_path):
    app, path = native
    fault = PFObject('Known fault', 'ComOutage')
    fault_key = gl.object_key(fault)
    sweep = Sweep([Sub(PERIOD_START, [fault, None], [(0, 110.0), (0, 145.0)])])

    def calculate(*args, **kwargs):
        return {'C1': {'status': 'CALCULATED', 'kind': gl.N1_REFERENCE,
                       'elements_of': {fault_key: set()},
                       'reference': {'kept': sweep, 'window_times': [PERIOD_START]}, 'scenario': None}}

    original = gl.run_case_manager

    def gui(*args, **kwargs):
        config = original(*args, **kwargs)
        config['analysis_name'] = 'Identity diagnostics'
        config['assessments'] = ['n-0', gl.N1_REFERENCE]
        return config

    monkeypatch.setattr(gl, 'run_case_manager', gui)
    monkeypatch.setattr(gl, 'calculate_n1', calculate)
    outcome = bridge.run_assessment(app, path)
    with closing(ScenarioStore(path)) as store:
        detail = raw.assessment(store.db, outcome['assessment_id'])
        native = next(row for row in detail['results'] if row['kind'] == 'n-1')
        assert native['status'] == 'incomplete' and native['metadata']['unresolved_rows'] == 1
        assert len(raw.contingencies(store.db, native['id'])) == 1
        [row] = store.db.execute('SELECT * FROM gl_unresolved_rows WHERE result_id=?', (native['id'],))
        assert row['row_index'] == 1 and json.loads(row['cells'])[0]['value'] == 145.0
        assert json.loads(row['diagnostic'])
        assert store.db.execute('SELECT COUNT(*) FROM gl_values WHERE result_id=?', (native['id'],)).fetchone()[0] == 1
        assert detail['evaluations']['C1']['n1']['status'] == 'NOT EVALUATED'
        assert len(store.overview()['scenarios']) == 1
    monkeypatch.setattr(settings, 'ANALYSIS_DB_PATH', str(path))
    monkeypatch.setattr(settings, 'ANALYSIS_MODE', 'sqlite')
    from app.main import app as web
    with TestClient(web) as client:
        body = client.get('/api/simulation/gridlens/results/' + native['id'] + '/unresolved-rows').json()
        assert body['total'] == 1 and body['rows'][0]['cells'][0]['value'] == 145.0
    from app.archive.parquet import export_analysis, import_analysis
    archive = export_analysis(path, outcome['assessment_id'], tmp_path / 'archives')
    restored = tmp_path / 'unresolved.sqlite3'
    import_analysis(archive, restored)
    with closing(ScenarioStore(restored)) as store:
        assert store.db.execute('SELECT COUNT(*) FROM gl_unresolved_rows').fetchone()[0] == 1


def test_calculation_name_validation_accepts_older_configs_and_rejects_invalid_names():
    config = gl.empty_case_config()
    config.pop('analysis_name')
    assert not gl.validate_case_config(config)
    for value in (None, 14, 'X' * 121):
        config['analysis_name'] = value
        assert any('calculation name' in problem for problem in gl.validate_case_config(config))
    config['analysis_name'] = 'Netzplanung – Woche 42'
    assert not gl.validate_case_config(config)


def test_identity_resolution_rejects_monitored_equipment_and_retains_diagnostics():
    owner = PFObject('Line A', 'ElmLne')
    axis = type('Axis', (), {'GetObjectValue': lambda *args: (0, owner),
                            'GetValue': lambda *args: (0, 90.0), 'GetObj': lambda *args: owner})()
    found, diagnostics = gl.contingency_row_object(axis, 0)
    assert found is None
    assert any(item.get('class') == 'ElmLne' for item in diagnostics)


def test_indexed_contingency_identity_is_shared_by_import_and_original_evaluator(native, monkeypatch):
    app, path = native
    fault = PFObject('Indexed fault', 'ComOutage')
    fault_key = gl.object_key(fault)

    class IndexedSub(Sub):
        def GetObjectValue(self, row, column=-1):
            return 0, -row - 1

        def GetObj(self, index):
            assert index < 0
            return self.faults[-index - 1]

    sweep = Sweep([IndexedSub(PERIOD_START, [fault], [(0, 110.0)])])
    original = gl.run_case_manager

    def gui(*args, **kwargs):
        config = original(*args, **kwargs)
        config['analysis_name'] = 'Indexed native result'
        config['assessments'] = ['n-0', gl.N1_REFERENCE]
        return config

    monkeypatch.setattr(gl, 'run_case_manager', gui)
    monkeypatch.setattr(gl, 'calculate_n1', lambda *a, **k: {
        'C1': {'status': 'CALCULATED', 'kind': gl.N1_REFERENCE, 'elements_of': {fault_key: set()},
               'reference': {'kept': sweep, 'window_times': [PERIOD_START]}, 'scenario': None}})
    outcome = bridge.run_assessment(app, path)
    with closing(ScenarioStore(path)) as store:
        detail = raw.assessment(store.db, outcome['assessment_id'])
        result = next(row for row in detail['results'] if row['kind'] == 'n-1')
        assert result['status'] == 'completed' and result['metadata']['unresolved_rows'] == 0
        assert raw.contingencies(store.db, result['id'])[0]['path'] == fault_key
        assert detail['evaluations']['C1']['n1']['status'] == 'EVALUATED'


def test_case_manager_requires_name_before_starting_calculation():
    from types import SimpleNamespace
    events = []
    dialog = object.__new__(gl.CaseManagerDialog)
    dialog.analysis_name = SimpleNamespace(text=lambda: '   ', setFocus=lambda: events.append('focus'))
    dialog.finish_editing = lambda: None
    dialog.error = lambda *args: events.append('error')
    dialog.show_page = lambda *args: events.append('cases page')
    dialog._settings_ready = lambda *a: pytest.fail('Must not start calculation without its name')
    dialog.start()
    assert events == ['error', 'cases page', 'focus']


def test_n1_index_does_not_need_qds_or_read_measurement_cells(native, monkeypatch):
    import sqlite3
    app, path = native
    # A QDS-only calculation has no native n-1 choices.
    first = bridge.run_assessment(app, path)
    with closing(ScenarioStore(path)) as store:
        assert raw.sweep_index(store.db, first['assessment_id'])['scenarios'] == []
        def authorize(action, table, *args):
            return sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_READ and table in ('gl_values', 'analysis_values') else sqlite3.SQLITE_OK
        store.db.set_authorizer(authorize)
        assert raw.sweep_index(store.db, first['assessment_id'])['analysis'] == first['assessment_id']
