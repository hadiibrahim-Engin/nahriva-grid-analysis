"""Copy the existing synthetic IEEE39 example and add explicitly synthetic hourly Redispatch costs.

No original results are changed. Run with backend/.venv/bin/python scripts/prepare_network_demo.py.
"""

import argparse
import json
import math
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from app.simulation import across, network, redispatch, timepoint, values  # noqa: E402
from app.simulation.store import ScenarioStore  # noqa: E402
from tests.ieee39 import GENERATOR_BUSES, HEIGHT, LINES, POSITIONS, SLACK, TRANSFORMERS, WIDTH, branch_name, bus_name, kv_of, map_svg  # noqa: E402


def hourly_dispatch(scenario, t, loading, active):
    """Illustrative balanced planning, not an OPF or a simulated post-Redispatch power flow.

    A congestion-dependent volume follows smooth demand/weather profiles. Three units ramp up,
    three ramp down and three do not participate. Down-regulation credits avoided generation costs.
    """
    moment = datetime.fromtimestamp(t, timezone.utc)
    hour = moment.hour
    morning = math.exp(-((hour - 8) / 3) ** 2)
    evening = math.exp(-((hour - 18) / 3.5) ** 2)
    demand = 0.72 + 0.22 * morning + 0.30 * evening
    weekday = 0.91 if moment.weekday() >= 5 else 1.0
    weather = 1 + 0.06 * math.sin(t / 86400 * 2 * math.pi / 5)
    volume = min(220, max(0, (loading or 0) - 85) * 2.2) * demand * weekday * weather if active else 0
    total = Decimal(str(volume)).quantize(Decimal('0.01'))
    up = [(scenario + n) % 9 for n in (1, 4, 7)]
    down = [(scenario + n) % 9 for n in (2, 5, 8)]
    energy = [Decimal('0.00')] * 9
    for units, sign in ((up, 1), (down, -1)):
        first = (total * Decimal('0.55')).quantize(Decimal('0.01'))
        second = (total * Decimal('0.30')).quantize(Decimal('0.01'))
        for unit, amount in zip(units, (first, second, total - first - second)):
            energy[unit] = sign * amount if amount else Decimal('0.00')
    result = []
    for unit, amount in enumerate(energy):
        # Different marginal offers per plant, with morning/evening scarcity and congestion premiums.
        price = (92 + unit * 3.8 + 16 * morning + 29 * evening + max(0, (loading or 0) - 100) * 0.32
                 if amount > 0 else 34 + unit * 1.6 + 5 * morning + 9 * evening)
        result.append((amount, Decimal(str(price)).quantize(Decimal('0.01'))))
    return result


def demo_map_svg():
    """Explicit demo voltage colours; imported operator SVGs are never rewritten."""
    ns = 'http://www.w3.org/2000/svg'
    ET.register_namespace('', ns)
    svg = ET.fromstring(map_svg())
    svg.set('viewBox', f'-40 -40 {WIDTH+80} {HEIGHT+120}')
    colours = {345: '#bd3544', 230: '#238653', 138: '#2468b4', 16.5: '#7851a9'}
    nodes = {node.get('id'): node for node in svg.iter()}
    find = lambda name: nodes[name.replace(' ', '_')]  # noqa: E731
    for a, b in LINES:
        find(branch_name('line', a, b)).set('stroke', colours[kv_of(a)])
    for a, b in TRANSFORMERS:
        for child, bus in zip(find(branch_name('trafo', a, b)), (a, b, a, b)):
            child.set('stroke', colours[kv_of(bus)])
    for n in POSITIONS:
        find(bus_name(n)).set('fill', colours[kv_of(n)])
    for n in GENERATOR_BUSES:
        name = 'External grid %02d' % n if n == SLACK else 'Gen %02d' % n
        for child in find(name):
            if child.tag.rsplit('}', 1)[-1] != 'text':
                child.set('stroke', colours[kv_of(n)])
    legend = ET.SubElement(svg, f'{{{ns}}}g', {'id': 'Voltage_legend', 'font-family': 'sans-serif', 'font-size': '12'})
    for i, (kv, colour) in enumerate(colours.items()):
        x = 30 + i * 170
        ET.SubElement(legend, f'{{{ns}}}path', {'d': f'M{x} {HEIGHT+54}h30', 'stroke': colour, 'stroke-width': '3'})
        ET.SubElement(legend, f'{{{ns}}}text', {'x': str(x + 38), 'y': str(HEIGHT+58), 'fill': '#334155'}).text = f'{kv:g} kV'
    return ET.tostring(svg, encoding='unicode')


def populate(store):
    timeline = network.timeline(store)
    cells = [(s['id'], c) for s in timeline['scenarios'] for c in s['cells'] if c]
    selected, peak = max(cells, key=lambda pair: pair[1]['value'])
    t = peak['t'] - peak['t'] % 3600
    analysis = timeline['analysis']
    plants = [r[0] for r in store.db.execute(
        "SELECT element_id FROM gl_elements WHERE assessment_id=? AND class_name='ElmSym' ORDER BY name", (analysis,))]
    if len(plants) != 9:
        raise ValueError('This synthetic IEEE39 profile requires the nine demo generators.')
    contexts, clock = [], set()
    for row, runs in network._scenarios(store, analysis):
        windows = across._outage_context(store, row)[2]
        course = timepoint.run_times(store, runs['OUTAGE'])['rows']
        contexts.append((row, windows, course))
        # Cover every maintenance period plus the day before/after, in every scenario.
        for start, end in windows:
            clock.update(range(int(start) - 24 * 3600, int(end) // 3600 * 3600 + 25 * 3600, 3600))
    clock.intersection_update(timeline['times'])
    iso = lambda n: datetime.fromtimestamp(n, timezone.utc).isoformat()  # noqa: E731
    rows = [','.join(redispatch.FIELDS)]
    for si, (scenario, windows, course) in enumerate(contexts):
        for hour in sorted(clock):
            active = any(start <= hour <= end for start, end in windows)
            loading = course.get(hour, (None,))[0]
            for plant, (energy, price) in zip(plants, hourly_dispatch(si, hour, loading, active)):
                rows.append(','.join((scenario['id'], plant, iso(hour), iso(hour+3600), str(energy), str(price))))
    redispatch.import_csv(store, analysis, 'DEMO_SYNTHETISCH_TAGESPROFILE_V2.csv', 'planned', '\n'.join(rows)+'\n')
    config = json.loads(store.db.execute('SELECT configuration FROM gl_assessments WHERE id=?', (analysis,)).fetchone()[0])
    config['analysis_name'] = 'DEMO · IEEE39 · Netzkarte und Redispatch'
    with store.db:
        store.db.execute('UPDATE gl_assessments SET configuration=? WHERE id=?', (json.dumps(config), analysis))
    maps = Path(store.path).parent / 'maps'
    maps.mkdir(exist_ok=True)
    (maps / 'ieee39.svg').write_text(demo_map_svg(), encoding='utf-8')
    return {'database': str(store.path), 't': t, 'scenario': selected, 'element': plants[0],
            'rows': len(rows)-1, 'hours': len(clock)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=ROOT / 'backend/data/network-workspace-demo')
    parser.add_argument('--refresh-demo', action='store_true', help='Add a new delivery revision to an existing, labelled demo only.')
    args = parser.parse_args()
    source = ROOT / 'backend/data/ieee39-example/ieee39.sqlite3'
    target = args.out.resolve() / 'network-demo.sqlite3'
    if target.exists() and not args.refresh_demo:
        raise SystemExit('Demo exists; open it instead: ' + str(target))
    if args.refresh_demo:
        if not target.is_file():
            raise SystemExit('There is no existing demo to refresh.')
        store = ScenarioStore(target)
        try:
            analysis = across.resolve_analysis(store.db, None)
            config = json.loads(store.db.execute('SELECT configuration FROM gl_assessments WHERE id=?', (analysis,)).fetchone()[0])
            delivery = redispatch.latest(store.db, analysis)
            if not config.get('analysis_name', '').startswith('DEMO · IEEE39') or not delivery or not delivery['source'].startswith('DEMO_'):
                raise SystemExit('Refresh is restricted to the labelled synthetic IEEE39 demo.')
            print(json.dumps(populate(store)))
        finally:
            store.close()
        return
    if not source.is_file():
        raise SystemExit('Build the IEEE39 example first: scripts/try_example.sh')
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as original, sqlite3.connect(target) as dest:
        original.backup(dest)
    if values.folder(source).is_dir():
        shutil.copytree(values.folder(source), values.folder(target))
    store = ScenarioStore(target)
    try:
        print(json.dumps(populate(store)))
    finally:
        store.close()


if __name__ == '__main__':
    main()
