"""Copy the existing synthetic IEEE39 example and add explicitly synthetic hourly Redispatch costs.

No original results are changed. Run with backend/.venv/bin/python scripts/prepare_network_demo.py.
"""

import argparse
import json
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from app.simulation import network, redispatch, values  # noqa: E402
from app.simulation.store import ScenarioStore  # noqa: E402
from tests.ieee39 import map_svg  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=ROOT / 'backend/data/network-workspace-demo')
    args = parser.parse_args()
    source = ROOT / 'backend/data/ieee39-example/ieee39.sqlite3'
    target = args.out.resolve() / 'network-demo.sqlite3'
    if target.exists():
        raise SystemExit('Demo exists; open it instead: ' + str(target))
    if not source.is_file():
        raise SystemExit('Build the IEEE39 example first: scripts/try_example.sh')
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as original, sqlite3.connect(target) as dest:
        original.backup(dest)
    if values.folder(source).is_dir():
        shutil.copytree(values.folder(source), values.folder(target))
    maps = target.parent / 'maps'
    maps.mkdir(exist_ok=True)
    (maps / 'ieee39.svg').write_text(map_svg(), encoding='utf-8')
    store = ScenarioStore(target)
    try:
        timeline = network.timeline(store)
        cells = [(s['id'], c) for s in timeline['scenarios'] for c in s['cells'] if c]
        selected, peak = max(cells, key=lambda pair: pair[1]['value'])
        t = peak['t'] - peak['t'] % 3600
        analysis = timeline['analysis']
        plants = [r[0] for r in store.db.execute(
            "SELECT element_id FROM gl_elements WHERE assessment_id=? AND class_name='ElmSym' ORDER BY name", (analysis,))]
        iso = lambda n: datetime.fromtimestamp(n, timezone.utc).isoformat()  # noqa: E731
        rows = [','.join(redispatch.FIELDS)]
        for si, scenario in enumerate(timeline['scenarios']):
            for pi, plant in enumerate(plants):
                for h in range(-24, 49):
                    hour = t + h * 3600
                    energy = Decimal((si+1)*(pi+2)%17 + h%7) / 10
                    if pi%4==0:
                        energy = -energy
                    price = Decimal(45 + si*4 + pi*3 + h%11)
                    rows.append(','.join((scenario['id'],plant,iso(hour),iso(hour+3600),str(energy),str(price))))
        redispatch.import_csv(store,analysis,'DEMO_SYNTHETISCH_KEINE_REALEN_KOSTEN.csv','planned','\n'.join(rows)+'\n')
        config = json.loads(store.db.execute('SELECT configuration FROM gl_assessments WHERE id=?',(analysis,)).fetchone()[0])
        config['analysis_name'] = 'DEMO · IEEE39 · Netzkarte und Redispatch'
        with store.db:
            store.db.execute('UPDATE gl_assessments SET configuration=? WHERE id=?',(json.dumps(config),analysis))
        print(json.dumps({'database':str(target),'t':t,'scenario':selected,'element':plants[0], 'rows':len(rows)-1}))
    finally:
        store.close()


if __name__ == '__main__':
    main()
