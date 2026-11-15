"""The data contract of an analysis: separation of imports, master data, states, time rules and migration.

Every import of a PowerFactory run is one analysis. These tests run the real path (main.py runtime, restoration,
bridge) against synthetic PowerFactory objects.
"""

import hashlib
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'powerfactory'))
import gridlens_dashboard as bridge  # noqa: E402
import gridlens_runtime as gl  # noqa: E402
from app.simulation import across, settings, states  # noqa: E402
from app.simulation import gridlens_store as raw  # noqa: E402
from app.simulation.store import LAYOUT_VERSION, ScenarioStore  # noqa: E402
from tests import large_dataset  # noqa: E402
from tests.gridlens_fixture import App, PlannedOutage  # noqa: E402
from tests.test_gridlens_dashboard import Result  # noqa: E402


def two_imports(path):
    """Two runs into one file with different networks and outages (20 then 25 branches)."""
    first = large_dataset.build(path, branches=20, cases=2, contingencies=5, window=24)
    second = large_dataset.build(path, branches=25, cases=2, contingencies=5, window=24)
    return first['assessment_id'], second['assessment_id']


@pytest.fixture
def client(monkeypatch):
    def open_client(path):
        monkeypatch.setattr(settings, 'ANALYSIS_DB_PATH', str(path))
        monkeypatch.setattr(settings, 'ANALYSIS_MODE', 'sqlite')
        from app.main import app
        return TestClient(app)
    return open_client


def test_every_import_is_its_own_analysis_and_never_mixed_with_another(tmp_path, client):
    path = tmp_path / 'two.sqlite3'
    first, second = two_imports(path)
    store = ScenarioStore(str(path))
    try:
        listed = across.analyses(store.db)
        assert [a['id'] for a in listed] == [second, first]  # newest first
        assert all(a['status'] == 'complete' and a['scenarios'] == 2 for a in listed)
        assert listed[0]['calculation_types'] == ['QDS', "(n-1)'", 'n-1']
        assert across.default_analysis(store.db) == second
        for analysis in (first, second):
            index = across.scenario_index(store, analysis)
            assert index['analysis'] == analysis and len(index['scenarios']) == 2
            # Every scenario keeps its own outage window and switched-off equipment, also the older import's.
            assert all(len(s['outages']) == 1 and len(s['outaged_element_ids']) == 1 for s in index['scenarios'])
            assert {s['id'].split('-')[0] for s in index['scenarios']} == {analysis}
        # The runs offered for charts belong to the chosen analysis only.
        runs = across.current_run_ids(store.db, first)
        owners = {row[0] for row in store.db.execute(
            'SELECT DISTINCT assessment_id FROM gl_results WHERE analysis_run_id IN ({})'.format(','.join('?' * len(runs))), tuple(runs))}
        assert owners == {first}
    finally:
        store.close()
    with client(path) as api:
        body = api.get('/api/simulation/analyses').json()
        assert body['default'] == second and [a['id'] for a in body['analyses']] == [second, first]
        index = api.get('/api/simulation/across-scenarios/index', params={'analysis': first}).json()
        assert index['analysis'] == first and len(index['scenarios']) == 2
        assert api.get('/api/simulation/across-scenarios/index').json()['analysis'] == second
        assert {f['id'] for f in api.get('/api/simulation/facilities', params={'analysis': first}).json()} == runs


def test_a_failed_import_marks_its_analysis_failed(tmp_path, monkeypatch):
    original = bridge._read_qds
    calls = []

    def fail(*args):
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError('storage failed')
        return original(*args)
    monkeypatch.setattr(bridge, '_read_qds', fail)
    path = tmp_path / 'failed.sqlite3'
    with pytest.raises(RuntimeError, match='storage failed'):
        large_dataset.build(path, branches=10, cases=1, contingencies=3, window=12)
    store = ScenarioStore(str(path))
    try:
        [analysis] = across.analyses(store.db)
        assert analysis['status'] == 'failed' and analysis['scenarios'] == 0
    finally:
        store.close()


def test_master_data_keeps_the_internal_key_and_the_nominal_voltage_and_no_invented_mrid(tmp_path, client):
    path = tmp_path / 'master.sqlite3'
    outcome = large_dataset.build(path, branches=10, cases=1, contingencies=3, window=12)
    store = ScenarioStore(str(path))
    try:
        rows = store.db.execute('SELECT * FROM gl_elements WHERE assessment_id=?', (outcome['assessment_id'],)).fetchall()
        assert len(rows) == 20  # 10 branches + 10 busbars
        project = json.loads(store.db.execute('SELECT payload FROM pf_catalog').fetchone()[0])['project_path']
        for row in rows:
            assert row['element_id'] == hashlib.sha256((project + '|' + row['path']).encode()).hexdigest()
            assert row['mrid'] is None  # no verified source for the CGMES mRID yet: nothing is guessed
            assert row['nominal_kv'] == 110 and row['grid'] in large_dataset.GRIDS
    finally:
        store.close()
    with client(path) as api:
        run = api.get('/api/simulation/facilities').json()[0]['id']
        components = api.get('/api/simulation/facilities/{}/components'.format(run)).json()
        assert {c['nominal_kv'] for c in components} == {110}
        page = api.get('/api/simulation/gridlens/assessments/{}/elements'.format(outcome['assessment_id']),
                       params={'limit': 5}).json()
        assert page['total'] == 20 and len(page['elements']) == 5


def test_every_state_the_api_reports_is_in_the_catalogue(tmp_path, client):
    path = tmp_path / 'states.sqlite3'
    outcome = large_dataset.build(path, branches=10, cases=1, contingencies=3, window=12)
    catalogue = states.catalogue()
    store = ScenarioStore(str(path))
    try:
        seen = {row[0] for row in store.db.execute('SELECT DISTINCT state FROM gl_values')}
        assert seen <= set(catalogue['cell'])
        assert {row[0] for row in store.db.execute('SELECT DISTINCT status FROM gl_results')} <= set(catalogue['result'])
        assert {row[0] for row in store.db.execute('SELECT DISTINCT status FROM gl_cases')} <= set(catalogue['case'])
        assert {row[0] for row in store.db.execute('SELECT status FROM gl_assessments')} <= set(catalogue['analysis'])
        n1 = next(r for r in raw.assessment(store.db, outcome['assessment_id'])['results'] if r['kind'] == 'n-1')
        contingency = raw.contingencies(store.db, n1['id'])[0]['id']
        assert {p['state'] for p in raw.series(store.db, n1['id'], 0, contingency)} <= set(catalogue['cell'])
    finally:
        store.close()
    with client(path) as api:
        body = api.get('/api/simulation/states').json()
        assert body['version'] == states.STATES_VERSION and 'not_recorded' in body['cell']


def test_the_time_axis_stays_unique_and_evenly_spaced_across_the_change_to_summer_time(tmp_path, monkeypatch):
    """Epoch seconds are UTC: the local switch to summer time (Berlin, 2025-03-30 02:00 -> 03:00) changes nothing."""
    monkeypatch.setenv('TZ', 'Europe/Berlin')
    time.tzset()
    try:
        start = int(datetime(2025, 3, 29, 23, 0, tzinfo=timezone.utc).timestamp())  # local midnight, 30 March
        outage = PlannedOutage('Night outage', starttime=start + 3600, endtime=start + 5 * 3600 - 1)
        app = App([outage])
        app.qds.startTime, app.qds.endTime = start - 86400, start + 2 * 86400
        app.qds.stepSize, app.qds.stepUnit = 15, 1
        app.qds.results = app.original_result = Result(qds=app.qds)
        monkeypatch.setattr(gl, 'CASE_SOURCE', 'per_outage')
        monkeypatch.setattr(gl, 'CASE_CONFIG_DIR', str(tmp_path / 'cases'))
        monkeypatch.setattr(gl, 'GRID_NAME_FILTER', '')
        outcome = bridge.run_assessment(app, tmp_path / 'dst.sqlite3')
        store = ScenarioStore(str(tmp_path / 'dst.sqlite3'))
        try:
            for result in raw.assessment(store.db, outcome['assessment_id'])['results']:
                stamps = raw.times(store.db, result['id'], 0, 5000)
                # main.py starts the run at the first outage, on a step grid that begins at its local midnight.
                assert stamps[0] == outage.starttime
                assert all(b - a == 900 for a, b in zip(stamps, stamps[1:]))  # no doubled or missing quarter hour
            catalog = json.loads(store.db.execute('SELECT payload FROM pf_catalog').fetchone()[0])
            assert (catalog['outages'][0]['start'], catalog['outages'][0]['end']) == (outage.starttime, outage.endtime)
        finally:
            store.close()
    finally:
        monkeypatch.delenv('TZ')
        time.tzset()


def test_a_file_of_the_previous_layout_is_brought_up_to_date_with_its_analyses(tmp_path):
    path = tmp_path / 'layout9.sqlite3'
    first, second = two_imports(path)
    # Make it a layout-9 file again: no analysis on the scenarios, no import facts, no master data.
    db = ScenarioStore(str(path)).db
    db.executescript('''
        DROP VIEW v_scenarios; DROP INDEX pf_scenarios_analysis;
        ALTER TABLE pf_scenarios DROP COLUMN analysis_id;
        ALTER TABLE gl_assessments DROP COLUMN status; ALTER TABLE gl_assessments DROP COLUMN calculation_types;
        ALTER TABLE gl_assessments DROP COLUMN period_start; ALTER TABLE gl_assessments DROP COLUMN period_end;
        DROP TABLE gl_elements;
        PRAGMA user_version = 9;
    ''')
    db.close()
    store = ScenarioStore(str(path))
    try:
        assert store.db.execute('PRAGMA user_version').fetchone()[0] == LAYOUT_VERSION
        assert {row[0] for row in store.db.execute('SELECT DISTINCT analysis_id FROM pf_scenarios')} == {first, second}
        listed = {a['id']: a for a in across.analyses(store.db)}
        assert listed[first]['status'] == 'complete' and listed[first]['calculation_types'] == ['(n-1)\'', 'QDS', 'n-1']
        assert listed[first]['period_start'] is not None
        assert len(across.scenario_index(store, first)['scenarios']) == 2
        assert store.db.execute('SELECT COUNT(*) FROM gl_elements').fetchone()[0] == 0  # not invented afterwards
    finally:
        store.close()
