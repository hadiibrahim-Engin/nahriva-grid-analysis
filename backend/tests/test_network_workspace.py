"""Cross-scenario clock/map data and explicit, auditable Redispatch hourly deliveries."""

import sqlite3
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.simulation import network, redispatch, settings, timepoint, values
from app.simulation.store import ScenarioStore, LAYOUT_VERSION


@pytest.fixture
def store(ieee39_example, tmp_path):
    path = tmp_path / 'results.sqlite3'
    with sqlite3.connect(ieee39_example) as original, sqlite3.connect(path) as target:
        original.backup(target)
    if values.folder(ieee39_example).is_dir():
        # Raw files are immutable; these tests only add metadata and external Redispatch rows.
        values.folder(path).symlink_to(values.folder(ieee39_example), target_is_directory=True)
    opened = ScenarioStore(path)
    yield opened
    opened.close()


def context(store):
    timeline = network.timeline(store)
    first = timeline['scenarios'][0]['id']
    plant = store.db.execute("SELECT element_id FROM gl_elements WHERE class_name='ElmSym' LIMIT 1").fetchone()[0]
    t = timeline['times'][0]
    return timeline['analysis'], first, plant, t - t % 3600


def delivery(scenario, plant, t, energy='2.5', price='80'):
    iso = lambda n: datetime.fromtimestamp(n, timezone.utc).isoformat()  # noqa: E731
    return ','.join(redispatch.FIELDS) + '\n' + ','.join((scenario, plant, iso(t), iso(t+3600), energy, price)) + '\n'


def test_heatmap_cells_keep_actual_peak_times_and_all_scenarios(store):
    result = network.timeline(store, points=12)
    assert len(result['scenarios']) == 6 and len(result['columns']) <= 12
    assert result['times'] == sorted(set(result['times']))
    for scenario in result['scenarios']:
        _row, runs = timepoint._scenario(store, scenario['id'])
        raw = timepoint.run_times(store, runs['OUTAGE'])['rows']
        for column, cell in zip(result['columns'], scenario['cells']):
            actual = [(t,r[0]) for t,r in raw.items() if column['start'] <= t <= column['end'] and r[0] is not None]
            assert cell['value'] == max(v for _t,v in actual)
            assert raw[cell['t']][0] == cell['value']


def test_exact_hour_asset_and_generators_are_kept_separate_from_redispatch(store):
    analysis, scenario, plant, t = context(store)
    result = network.at_time(store, analysis, t, plant)
    assert len(result['scenarios']) == 6
    assert len(result['plants']) == 6 * 9  # nine generators; the external grid is not a power plant
    assert result['delivery'] is None
    assert all(p['cost_eur'] is None and p['energy_mwh'] is None for p in result['plants'])
    assert any(p['active_power_mw'] is not None for p in result['plants'])
    own = next(s for s in result['scenarios'] if s['id'] == scenario)
    assert own['value'] == next(p['active_power_mw'] for p in result['plants'] if p['element_id'] == plant and p['scenario_id'] == scenario)
    absent = network.at_time(store, analysis, t - 1, plant)
    assert all(s['value'] is None and not s['has_time'] for s in absent['scenarios'])


def test_hourly_costs_preserve_sign_zero_missing_values_and_latest_revision(store):
    analysis, scenario, plant, t = context(store)
    redispatch.import_csv(store, analysis, 'first.csv', 'planned', delivery(scenario,plant,t,'-2.5','80.125'))
    first = network.at_time(store, analysis, t+1800, plant)
    row = next(p for p in first['plants'] if p['scenario_id']==scenario and p['element_id']==plant)
    assert row['cost_eur'] == -200.3125 and row['price_eur_per_mwh'] == 80.125
    assert first['hour_start'] == t
    assert any(p['cost_eur'] is None for p in first['plants'])
    stored = store.db.execute('SELECT cost_eur FROM rd_hours').fetchone()[0]
    assert Decimal(stored) == Decimal('-200.3125')
    redispatch.import_csv(store, analysis, 'second.csv', 'delivered', delivery(scenario,plant,t,'0','80.125'))
    second = network.at_time(store, analysis, t, plant)
    own = next(s for s in second['scenarios'] if s['id']==scenario)
    assert own['redispatch']['cost_eur'] == 0
    assert second['delivery']['quantity_kind'] == 'delivered'
    assert store.db.execute('SELECT COUNT(*) FROM rd_imports').fetchone()[0] == 2
    assert network.at_time(store, analysis, t+3600, plant)['scenarios'][0]['redispatch'] is None
    heatmap = network.timeline(store, analysis, metric='redispatch')
    assert heatmap['scenarios'][0]['cells'] == [{'t': t, 'value': 0.0}]
    assert all(cell is None for s in heatmap['scenarios'][1:] for cell in s['cells'])


@pytest.mark.parametrize('problem', ['NaN', 'huge-exponent', 'duplicate', 'foreign', 'half-hour', 'no-zone'])
def test_invalid_deliveries_are_atomic_and_do_not_guess_mappings(store, problem):
    analysis, scenario, plant, t = context(store)
    text = delivery(scenario,plant,t)
    if problem == 'NaN': text = delivery(scenario,plant,t,energy='NaN')
    if problem == 'huge-exponent': text = delivery(scenario,plant,t,energy='1e999999999')
    if problem == 'duplicate': text += text.splitlines()[1] + '\n'
    if problem == 'foreign': text = delivery('other-analysis',plant,t)
    if problem == 'half-hour': text = delivery(scenario,plant,t+1800)
    if problem == 'no-zone': text = text.replace('+00:00','')
    with pytest.raises(ValueError):
        redispatch.import_csv(store,analysis,'invalid.csv','delivered',text)
    assert store.db.execute('SELECT COUNT(*) FROM rd_imports').fetchone()[0] == 0
    assert store.db.execute('SELECT COUNT(*) FROM rd_hours').fetchone()[0] == 0


def test_large_decimal_products_keep_every_supplied_digit_and_cost_only_hours_are_navigable(store):
    analysis, scenario, plant, t = context(store)
    energy, price = '999999999999.123456789', '-999999999999.987654321'
    outside = t - 10*86400
    redispatch.import_csv(store,analysis,'exact.csv','delivered',delivery(scenario,plant,outside,energy,price))
    stored = store.db.execute('SELECT cost_eur FROM rd_hours').fetchone()[0]
    assert stored == '-999999999999111111110000.010821521112635269'
    timeline = network.timeline(store)
    assert outside in timeline['times']
    hour = network.at_time(store,analysis,outside,plant)
    assert not any(s['has_time'] for s in hour['scenarios'])
    assert next(p for p in hour['plants'] if p['scenario_id']==scenario and p['element_id']==plant)['cost_eur'] is not None


def test_network_routes_and_network_mode_cannot_import(store, monkeypatch):
    from app.main import app
    analysis, scenario, plant, t = context(store)
    monkeypatch.setattr(settings,'ANALYSIS_DB_PATH',store.path)
    monkeypatch.setattr(settings,'ALLOW_DB_SWITCH',False)
    with TestClient(app) as client:
        assert client.get('/api/simulation/network/timeline').status_code == 200
        assert client.get('/api/simulation/network/timeline?metric=unknown').status_code == 422
        assert client.get('/api/simulation/network/timeline?start=2&end=1').status_code == 422
        assert client.get('/api/simulation/network/at-time',params={'analysis':analysis,'t':t,'element':plant}).json()['element']['element_id']==plant
        body={'analysis':analysis,'source':'x.csv','quantity_kind':'delivered','csv':delivery(scenario,plant,t)}
        assert client.post('/api/simulation/redispatch/import',json=body).status_code == 403
        monkeypatch.setattr(settings,'ALLOW_DB_SWITCH',True)
        assert client.post('/api/simulation/redispatch/import',json=body).status_code == 200


def test_archive_roundtrip_keeps_external_delivery_revision_and_exact_costs(store,tmp_path):
    from app.archive.parquet import export_analysis, import_analysis
    analysis, scenario, plant, t = context(store)
    redispatch.import_csv(store,analysis,'market.csv','requested',delivery(scenario,plant,t,'3.125','78.1234'))
    archive=export_analysis(store.path,analysis,tmp_path/'archive')
    target=tmp_path/'restore.sqlite3'
    import_analysis(archive,target)
    restored=ScenarioStore(target)
    try:
        assert restored.db.execute('PRAGMA user_version').fetchone()[0]==LAYOUT_VERSION
        for table in ('rd_imports','rd_hours'):
            assert [tuple(r) for r in restored.db.execute('SELECT * FROM '+table)]==[tuple(r) for r in store.db.execute('SELECT * FROM '+table)]
    finally:
        restored.close()


def test_legacy_database_exports_read_only_without_redispatch_tables(store,tmp_path):
    from app.archive.parquet import export_analysis, import_analysis
    analysis, _scenario, _plant, _t = context(store)
    store.db.executescript('DROP TABLE rd_hours; DROP TABLE rd_imports; PRAGMA user_version=17;')
    archive = export_analysis(store.path, analysis, tmp_path/'legacy-archive')
    assert store.db.execute('PRAGMA user_version').fetchone()[0] == 17
    assert not store.db.execute("SELECT 1 FROM sqlite_master WHERE name='rd_hours'").fetchone()
    target=tmp_path/'legacy-restore.sqlite3'
    import_analysis(archive,target)
    restored=ScenarioStore(target)
    try:
        assert restored.db.execute('SELECT COUNT(*) FROM rd_hours').fetchone()[0]==0
        assert network.timeline(restored)['analysis']==analysis
    finally:
        restored.close()
