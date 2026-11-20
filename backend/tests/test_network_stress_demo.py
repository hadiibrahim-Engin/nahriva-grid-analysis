"""The performance demo counts real matched equipment and imports real hourly series, not SVG-only copies."""

import importlib.util
from decimal import Decimal
from pathlib import Path

import pytest

from app.simulation import maps, network, settings
from app.simulation.store import ScenarioStore
from tests import large_dataset

spec=importlib.util.spec_from_file_location('network_stress_demo',Path(__file__).resolve().parents[2]/'scripts/prepare_network_stress_demo.py')
demo=importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)


@pytest.fixture(scope='module')
def generated(tmp_path_factory):
    path=tmp_path_factory.mktemp('stress-demo')/'stress.sqlite3'
    model=demo.StressModel(regions=2)
    large_dataset.build(path,model=model)
    (path.parent/'maps').mkdir()
    (path.parent/'maps'/'stress.svg').write_text(demo.svg_of(model))
    return path,model


def test_stress_layers_are_unique_and_maintenance_uses_the_calculated_branch(generated,monkeypatch):
    path,model=generated
    monkeypatch.setattr(settings,'ANALYSIS_DB_PATH',str(path))
    monkeypatch.delenv('OA_MAP_DIR',raising=False)
    layers=maps.element_layers(demo.svg_of(model))
    assert len(layers)==len(set(layers))==600
    for outage in model.outages:
        assert outage.components==[model.branches[outage.branch]]
        assert model.loading(outage.branch,outage.starttime,[outage])==0
    store=ScenarioStore(path)
    try:
        matched=maps.match(store.db,'stress')
        assert matched['counts']=={'layers':600,'matched':600,'elements':600,'elements_without_layer':0}
        timeline=network.timeline(store)
        scenario=next(s['id'] for s in timeline['scenarios'] if s['name']=='Maintenance '+model.outages[0].components[0].loc_name)
        snapshot=maps.values(store,'stress',scenario,timeline['times'][0])
        assert len(snapshot['v'])==600
        assert set(snapshot['m'])=={0,1,2}
        assert len(snapshot['off'])==1
    finally:
        store.close()


def test_stress_costs_cover_every_hour_scenario_generator_and_balance(generated):
    path,model=generated
    store=ScenarioStore(path)
    try:
        timeline=network.timeline(store)
        delivery=demo.add_costs(store,model,timeline)
        assert delivery['rows']==len(timeline['times'])*len(timeline['scenarios'])*len(model.sources)
        totals={}
        for row in store.db.execute('SELECT scenario_id,start_t,energy_mwh,cost_eur FROM rd_hours WHERE import_id=?',(delivery['id'],)):
            energy,cost=totals.get((row[0],row[1]),(Decimal(0),Decimal(0)))
            totals[row[0],row[1]]=energy+Decimal(row[2]),cost+Decimal(row[3])
        assert all(energy==0 and cost>=0 for energy,cost in totals.values())
    finally:
        store.close()
