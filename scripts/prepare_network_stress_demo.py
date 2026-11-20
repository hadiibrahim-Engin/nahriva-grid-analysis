"""Build a separate, reproducible 30,000-equipment performance demo through the real import path.

Synthetic benchmark values, not an electrically validated or post-Redispatch load flow. No N-1 sweep.
Run: backend/.venv/bin/python scripts/prepare_network_stress_demo.py
"""

import argparse
import json
import math
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from app.simulation import across, network, redispatch, values  # noqa: E402
from app.simulation.store import ScenarioStore  # noqa: E402
from tests import large_dataset  # noqa: E402
from tests.gridlens_fixture import PFObject  # noqa: E402
from tests.large_dataset import Equipment, GRIDS, Model, YEAR_START  # noqa: E402

PER_REGION = 149  # branches + as many busbars + two generators: 300 equipment per region
VOLTAGES = (380, 220, 110)
COLOURS = {380: '#bd3544', 220: '#238653', 110: '#2468b4', 20: '#7851a9'}
TILE_W, TILE_H = 820, 620


class StressModel(Model):
    def __init__(self, regions=100):
        super().__init__(PER_REGION * regions, min(6,regions), 0, 24, spacing=2)
        self.regions = regions
        self.sources = []
        self.shift = 1.55
        for i, (branch, bus) in enumerate(zip(self.branches, self.buses)):
            region = i // PER_REGION
            grid, kv = GRIDS[region % len(GRIDS)], VOLTAGES[region % len(VOLTAGES)]
            branch.grid = bus.grid = grid
            branch.uknom = bus.uknom = kv
        for i in range(regions * 2):
            bus = self.buses[(i // 2) * PER_REGION + (30 if i % 2 else 105)]
            self.sources.append(Equipment(f'Generator G{i:04d}', 'ElmSym', bus.grid, uknom=20,
                                          bus1=PFObject('Cub_G', 'StaCubic', cterm=bus)))
        # Distinct maintenance locations near the middle of the drawing; each case remains independent.
        for k, outage in enumerate(self.outages):
            branch = (((regions // 2 + k) % regions) * PER_REGION + 70) % len(self.branches)
            outage.components = [self.branches[branch]]
            outage.loc_name = 'Maintenance ' + self.branches[branch].loc_name
            outage.branch = branch
            outage.neighbours = {(branch + d) % len(self.branches) for d in range(-180, 181) if d}

    def generation(self, i, t):
        hour = (t-YEAR_START) / 3600
        return 90 + (i * 17 % 180) + 28 * math.sin(2*math.pi*(hour-7)/24) + 9*math.cos(hour/19+i)

    def columns(self):
        return (super().columns()
                + [(b, 'm:P:bushv' if b.kind=='ElmTr2' else 'm:P:bus1', 'MW',
                    lambda t, a, i=i: self.loading(i,t,a)*4*(-1 if i%7==0 else 1)) for i,b in enumerate(self.branches)]
                + [(g, 'm:P:bus1', 'MW', lambda t, _a, i=i: self.generation(i,t)) for i,g in enumerate(self.sources)])


def position(region, local, columns):
    row, column = divmod(local, 15)
    if row % 2:
        column = 14-column
    return ((region % columns)*TILE_W + 55 + column*49,
            (region // columns)*TILE_H + 70 + row*48)


def svg_of(model):
    columns = math.ceil(math.sqrt(model.regions))
    rows = math.ceil(model.regions/columns)
    width, height = columns*TILE_W, rows*TILE_H
    background, equipment, labels, generators = [], [], [], []
    for region in range(model.regions):
        x, y = (region % columns)*TILE_W, (region // columns)*TILE_H
        kv = VOLTAGES[region % len(VOLTAGES)]
        background.append(f'<rect x="{x+8}" y="{y+8}" width="{TILE_W-16}" height="{TILE_H-16}" rx="10" fill="#fafcfd" stroke="#dce3e8"/>'
                          f'<text x="{x+30}" y="{y+35}" fill="#334155" font-size="17">Region {region+1:03d} · {GRIDS[region%3]} · {kv} kV</text>')
        for local in range(PER_REGION):
            i = region*PER_REGION+local
            x1,y1 = position(region,local,columns)
            # Snake through the busbars; the final line provides a short vertical tie.
            target = local+1 if local<PER_REGION-1 else 121
            x2,y2 = position(region,target,columns)
            branch,bus = model.branches[i],model.buses[i]
            name=branch.loc_name.replace(' ','_')
            colour=COLOURS[kv]
            path=f'<path d="M{x1} {y1}L{x2} {y2}" stroke="{colour}" stroke-width="2"/>'
            if branch.kind=='ElmTr2':
                cx,cy=(x1+x2)/2,(y1+y2)/2
                path += f'<circle cx="{cx-3}" cy="{cy}" r="5" stroke="{colour}" fill="white"/><circle cx="{cx+3}" cy="{cy}" r="5" stroke="{colour}" fill="none"/>'
            equipment.append(f'<g id="{name}">{path}</g>')
            equipment.append(f'<rect id="{bus.loc_name.replace(" ","_")}" x="{x1-9}" y="{y1-2}" width="18" height="4" fill="{colour}"/>')
            labels.append(f'<text x="{x1+10}" y="{y1-5}" font-size="12" fill="#475569">B{i}</text>')
        for unit, local in enumerate((105,30)):
            x,y=position(region,local,columns)
            gy=y+(22 if unit else -22)
            name=model.sources[region*2+unit].loc_name.replace(' ','_')
            generators.append(f'<g id="{name}"><path d="M{x} {y}V{gy}" stroke="{COLOURS[20]}" stroke-width="2"/>'
                              f'<circle cx="{x}" cy="{gy}" r="7" fill="white" stroke="{COLOURS[20]}" stroke-width="2"/>'
                              f'<text x="{x-3}" y="{gy+3}" font-size="8" fill="{COLOURS[20]}">G</text></g>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-20 -20 {width+40} {height+40}" fill="none" font-family="sans-serif">'
            '<g id="Performance_network"><g id="Background">'+''.join(background)+'</g>'
            '<g id="Elements">'+''.join(equipment)+'</g><g id="Generators">'+''.join(generators)+'</g>'
            '<g id="Labels">'+''.join(labels)+'</g></g></svg>')


def add_costs(store, model, timeline):
    analysis=timeline['analysis']
    plant_ids=dict(store.db.execute("SELECT name,element_id FROM gl_elements WHERE assessment_id=? AND class_name='ElmSym'",(analysis,)))
    scenarios=network._scenarios(store,analysis)
    hours=timeline['times']
    if len(hours)*len(model.sources)*len(scenarios)>50_000:
        raise ValueError('Demo delivery would exceed the hourly import contract.')
    iso=lambda t: datetime.fromtimestamp(t,timezone.utc).isoformat()  # noqa: E731
    rows=[','.join(redispatch.FIELDS)]
    for si,(scenario,_runs) in enumerate(scenarios):
        windows=across._outage_context(store,scenario)[2]
        for t in hours:
            hour=(t-YEAR_START)/3600
            active=any(start<=t<=end for start,end in windows)
            for region in range(model.regions):
                distance=abs(region-(model.regions//2+si)%model.regions)
                volume=max(0,45-distance*14)*(0.8+0.2*math.sin(2*math.pi*(hour-8)/24)) if active else 0
                energy=Decimal(str(volume)).quantize(Decimal('0.01'))
                for unit in (0,1):
                    amount=(-energy if unit==0 and energy else energy)
                    price=Decimal(str((38 if unit==0 else 112)+region%11+12*max(0,math.sin(2*math.pi*(hour-8)/24)))).quantize(Decimal('0.01'))
                    plant=plant_ids[model.sources[region*2+unit].loc_name]
                    rows.append(','.join((scenario['id'],plant,iso(t),iso(t+3600),str(amount),str(price))))
    return redispatch.import_csv(store,analysis,'DEMO_STRESSTEST_30000.csv','planned','\n'.join(rows)+'\n')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=Path,default=ROOT/'backend/data/network-stress-30000')
    args=parser.parse_args()
    directory=args.out.resolve()
    path=directory/'network-stress.sqlite3'
    if path.exists():
        raise SystemExit('Demo already exists: '+str(path))
    directory.mkdir(parents=True,exist_ok=True)
    start=time.perf_counter()
    model=StressModel()
    large_dataset.build(path,model=model)
    maps=directory/'maps'
    maps.mkdir(exist_ok=True)
    svg=svg_of(model)
    (maps/'stress-30000.svg').write_text(svg,encoding='utf-8')
    store=ScenarioStore(path)
    try:
        timeline=network.timeline(store)
        analysis=timeline['analysis']
        counts=dict(store.db.execute('SELECT class_name,COUNT(*) FROM gl_elements WHERE assessment_id=? GROUP BY class_name',(analysis,)))
        assert sum(counts.values())==30_000, counts
        delivery=add_costs(store,model,timeline)
        config=json.loads(store.db.execute('SELECT configuration FROM gl_assessments WHERE id=?',(analysis,)).fetchone()[0])
        config['analysis_name']='DEMO · Performance · 30.000 Betriebsmittel'
        with store.db:
            store.db.execute('UPDATE gl_assessments SET configuration=? WHERE id=?',(json.dumps(config),analysis))
        selected,peak=max(((s['id'],cell) for s in timeline['scenarios'] for cell in s['cells'] if cell),key=lambda p:p[1]['value'])
        report={'database':str(path),'map':'stress-30000','analysis':analysis,'equipment':sum(counts.values()),'classes':counts,
                'regions':model.regions,'scenarios':len(timeline['scenarios']),'hours':len(timeline['times']),
                'qds_values':store.db.execute('SELECT SUM(rows) FROM pf_run_values').fetchone()[0],
                'redispatch_rows':delivery['rows'],'svg_bytes':len(svg.encode()),'database_bytes':path.stat().st_size,
                'value_bytes':sum(p.stat().st_size for p in values.folder(path).glob('*') if p.is_file()),
                'build_s':round(time.perf_counter()-start,2),'t':peak['t'],'scenario':selected,
                'synthetic':True,'n1':False}
        (directory/'manifest.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report,indent=2),flush=True)
    finally:
        store.close()


if __name__=='__main__':
    main()
