"""Inventory lists calculations and import quality without reading measurement cells."""

import json
import sqlite3
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

from app.simulation import inventory, settings
from app.simulation.store import ScenarioStore
from tests.qds_fixture import create_dummy_database


@pytest.fixture
def database(tmp_path):
    path = tmp_path / 'calculations.sqlite3'
    with closing(ScenarioStore(path)) as store:
        with store.db:
            for identifier, name, date in [('a', 'Winter plan', '2026-11-15'), ('b', 'Summer plan', '2026-11-16')]:
                store.db.execute(
                    'INSERT INTO gl_assessments(id,native_run_id,project,study_case,engine_version,created_at,settings,configuration,mode,status) '
                    'VALUES(?,?,?,?,?,?,?,?,?,?)', (identifier, identifier + '-run', 'Grid', 'Study', '8.2', date, '{}',
                                                   json.dumps({'analysis_name': name}), 'calculated', 'complete'))
            for analysis, case, name, status in [('a', 'C1', 'Line North', 'READY'), ('a', 'C2', 'Line South', 'NOT SIMULATED'),
                                                  ('b', 'C1', 'Transformer', 'READY')]:
                store.db.execute('INSERT INTO gl_cases VALUES(?,?,?,?,?,?)', (analysis, case, name, status, '', '{}'))
            for analysis in ('a', 'b'):
                store.db.execute('INSERT INTO pf_jobs(id,kind,payload,status,created_at) VALUES(?,?,?,?,?)',
                                 (analysis + '-C1', 'gridlens', '{}', 'completed', '2026-11-16'))
                store.db.execute('INSERT INTO pf_scenarios VALUES(?,?,?,?,?,?,?)',
                                 (analysis + '-C1', 'Imported case', 'Grid', 'Study', '[]', '2026-11-16', analysis))
            for identifier, analysis, case, kind, status in [
                ('q1', 'a', 'REF', 'QDS', 'completed'), ('q2', 'a', 'C1', 'QDS', 'completed'),
                ('n1', 'a', 'C1', 'n-1', 'completed'), ('n2', 'a', 'C2', 'n-1', 'not_calculated'),
                ('n3', 'b', 'C1', 'n-1', 'incomplete'), ('p1', 'b', 'C1', "(n-1)'", 'failed'),
            ]:
                store.db.execute('INSERT INTO gl_results VALUES(?,?,?,?,?,?,?,?,?,?)',
                                 (identifier, analysis, case, kind, 'Native', '/Native/' + identifier, status, '', '{}', None))
    return path


def test_inventory_counts_calculations_cases_and_distinguishes_failed_results(database):
    with closing(ScenarioStore(database)) as store:
        result = inventory.contents(store)
        assert result['filename'] == 'calculations.sqlite3' and result['sqlite_bytes'] > 0
        assert result['default_analysis'] == 'b'
        totals = result['totals']
        assert totals['calculations'] == 2 and totals['cases'] == 3 and totals['imported_cases'] == 2
        assert totals['results']['QDS'] == {'completed': 2}
        assert totals['results']['n-1'] == {'completed': 1, 'not_calculated': 1, 'incomplete': 1}
        assert totals['results']["(n-1)'"] == {'failed': 1}
        first = next(item for item in result['analyses'] if item['id'] == 'a')
        assert first['name'] == 'Winter plan'
        assert [case['name'] for case in first['cases']] == ['Line North', 'Line South']
        assert not store.db.in_transaction


def test_inventory_never_reads_measurement_tables_or_writes_data(database):
    with closing(ScenarioStore(database)) as store:
        forbidden = {'gl_values', 'analysis_values', 'pf_run_times', 'gl_n1_hourly', 'pf_scenario_cells'}
        def authorize(action, table, *args):
            if action in (sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE):
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_READ and table in forbidden else sqlite3.SQLITE_OK
        store.db.set_authorizer(authorize)
        assert inventory.contents(store)['totals']['calculations'] == 2


def test_inventory_preserves_a_callers_existing_transaction(database):
    with closing(ScenarioStore(database)) as store:
        store.db.execute("UPDATE gl_cases SET name='Pending change' WHERE assessment_id='a' AND case_id='C1'")
        assert store.db.in_transaction
        assert inventory.contents(store)['totals']['cases'] == 3
        assert store.db.in_transaction
        assert store.db.execute("SELECT name FROM gl_cases WHERE assessment_id='a' AND case_id='C1'").fetchone()[0] == 'Pending change'
        store.db.rollback()


def test_inventory_handles_empty_and_legacy_databases(tmp_path):
    with closing(ScenarioStore(tmp_path / 'empty.sqlite3')) as store:
        result = inventory.contents(store)
        assert result['analyses'] == [] and result['totals']['calculations'] == 0
    path = create_dummy_database(tmp_path / 'legacy.sqlite3')
    with closing(ScenarioStore(path)) as store:
        result = inventory.contents(store)
        assert result['totals']['calculations'] == 0
        assert result['totals']['unassigned_cases'] > 0
        assert result['analyses'][0]['cases'] and result['analyses'][0]['cases'][0]['name']
        runs = store.db.execute('SELECT COUNT(DISTINCT run_id) FROM pf_scenario_runs').fetchone()[0]
        assert sum(result['totals']['results']['QDS'].values()) == runs > 0


def test_contents_api_is_available_when_database_switching_is_disabled(database, monkeypatch):
    monkeypatch.setattr(settings, 'ANALYSIS_DB_PATH', str(database))
    monkeypatch.setattr(settings, 'ANALYSIS_MODE', 'sqlite')
    monkeypatch.setattr(settings, 'ALLOW_DB_SWITCH', False)
    from app.main import app
    with TestClient(app) as client:
        response = client.get('/api/simulation/database/contents')
        assert response.status_code == 200
        assert response.json()['totals']['calculations'] == 2
        assert response.json()['analyses'][0]['name'] == 'Summer plan'
        assert client.post('/api/simulation/database', json={'path': str(database)}).status_code == 403
