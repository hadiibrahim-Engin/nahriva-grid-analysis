"""A large synthetic results database for trying the dashboard locally. Development only, never shipped.

Runs the real path of a PowerFactory run: the main.py runtime (planning cases, REF and case QDS runs,
restoration) and the dashboard bridge (case-by-case import, dashboard summaries, n-1 summaries). Only
PowerFactory is replaced by synthetic objects; the n-1 and (n-1)' sweeps of every case are synthetic kept
results handed to the bridge as PowerFactory's contingency analysis would leave them.

    cd backend
    .venv/bin/python -m tests.large_dataset
    .venv/bin/python -m tests.large_dataset --branches 500 --cases 10 --contingencies 150 --window 168
    .venv/bin/python -m tests.large_dataset --branches 100000 --cases 2 --contingencies 0 --window 24 --spacing 48 --db x.sqlite3
    .venv/bin/python ../scripts/run_dashboard.py --db data/synthetic-large.sqlite3

The model: branches (lines, every tenth a transformer) and busbars in three grids, a daily and a seasonal load
swing per branch, one planned outage per case that switches its branch off and loads its neighbours, and per
branch and hour one contingency that hits it hardest (it changes every eight hours). Values inside the
recording limits of the contingency analysis (loading below 80 %, voltage inside 0.95 to 1.05 p.u.) are not
recorded, as in PowerFactory.
"""

import argparse
import copy
import math
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for folder in ('backend', 'powerfactory'):
    if str(ROOT / folder) not in sys.path:
        sys.path.insert(0, str(ROOT / folder))

import gridlens_dashboard as bridge  # noqa: E402
import gridlens_runtime as gl  # noqa: E402
from tests.gridlens_fixture import App, PFObject, PlannedOutage  # noqa: E402

YEAR_START = int(datetime(2025, 1, 1, tzinfo=timezone.utc).timestamp())
GRIDS = ('North', 'Central', 'South')
RECORDING_LOADING = 80.0
RECORDING_VOLTAGE = (0.95, 1.05)


class Equipment(PFObject):
    """A branch or busbar with a full path inside its grid, so that the dashboard's grid filter has something to do."""

    def __init__(self, name, kind, grid, **attributes):
        super().__init__(name, kind, outserv=0, **attributes)
        self.grid = grid

    def GetFullName(self):
        return 'Project\\Network Model\\{}.ElmNet\\{}.{}'.format(self.grid, self.loc_name, self.kind)


class Model:
    # Factor on the loading of the neighbours of a switched-off branch.
    shift = 1.32

    def __init__(self, branches, cases, contingencies, window_hours, spacing=None):
        self.branches = [Equipment(('Transformer T%d' if i % 10 == 9 else 'Line L%d') % i, 'ElmTr2' if i % 10 == 9 else 'ElmLne',
                                   GRIDS[i % 3], uknom=110) for i in range(branches)]
        self.buses = [Equipment('Busbar B%d' % i, 'ElmTerm', GRIDS[i % 3], uknom=110) for i in range(branches)]
        self.base = [30 + (i * 37 % 35) for i in range(branches)]
        # Named after the outaged branch, as PowerFactory names the contingencies it creates.
        self.faults = [PFObject(self.branches[(j * 13) % branches].loc_name, 'ComOutage', outserv=0)
                       for j in range(contingencies)]
        self.fault_branch = [(j * 13) % branches for j in range(contingencies)]
        # Hours between the starts of two planned outages; by default spread over the year. A small spacing keeps the
        # QDS period short (main.py follows the outages), for very many branches.
        spacing = spacing or max(window_hours + 24, (300 * 24) // max(cases, 1))
        self.outages = []
        for k in range(cases):
            start = YEAR_START + (20 * 24 + k * spacing) * 3600
            branch = (k * 37 + 5) % branches
            outage = PlannedOutage('Maintenance %s' % self.branches[branch].loc_name, equipment=[self.branches[branch]],
                                   starttime=start, endtime=start + window_hours * 3600 - 1)
            outage.branch = branch
            outage.neighbours = {(branch + d) % branches for d in range(-6, 7) if d}
            self.outages.append(outage)

    def loading(self, i, t, active=()):
        """Loading of branch i at epoch second t; 0 while a planned outage switches it off, as PowerFactory writes it."""
        hour = (t - YEAR_START) / 3600
        value = self.base[i] + 16 * math.sin(2 * math.pi * hour / 24) + 9 * math.cos(2 * math.pi * hour / 8760) + (i * hour) % 5
        for outage in active:
            if outage.starttime <= t <= outage.endtime:
                if i == outage.branch:
                    return 0.0
                if i in outage.neighbours:
                    value *= self.shift
        return max(value, 0.5)

    def voltage(self, i, t, active=()):
        return 1.02 - 0.0006 * self.loading(i, t, active)

    def solvable(self, fault, moment, active):
        """Whether the contingency has a load-flow solution (False: it would cut off part of the network)."""
        return True

    def n1_loading(self, i, fault, moment, active, pre):
        """Loading of branch i after contingency `fault` at `moment`: synthetic, one contingency per branch and
        eight hours hits it hardest."""
        hour = (moment - YEAR_START) // 3600
        trigger = (i * 7 + hour // 8) % len(self.faults)
        return pre * (1.45 if fault == trigger else 1.12 if fault % 23 == i % 23 else 1.0)

    def n1_voltage(self, i, fault, moment, active, pre):
        """Voltage of busbar i after contingency `fault`."""
        return 1.02 - 0.0006 * self.n1_loading(i, fault, moment, active, pre)

    def columns(self):
        """The recorded QDS columns: (object, variable, unit, value at epoch second t with the active outages)."""
        return ([(b, 'c:loading', '%', lambda t, a, i=i: self.loading(i, t, a)) for i, b in enumerate(self.branches)]
                + [(n, 'm:u', 'p.u.', lambda t, a, i=i: self.voltage(i, t, a)) for i, n in enumerate(self.buses)])


class QdsResult(PFObject):
    """ElmRes of a QDS: a relative hour axis over the period the ComStatsim is set to when the copy is kept."""

    def __init__(self, model, qds):
        super().__init__('Quasi-Dynamic Simulation AC', 'ElmRes')
        self.model, self.qds = model, qds
        self.columns = [(PFObject('Time', 'SetTime'), 'b:tnow', 'h', None)] + model.columns()
        self.start, self.rows, self.active = 0, 0, ()

    def clone(self):
        kept = copy.copy(self)
        kept.start = int(self.qds.startTime)
        kept.rows = int((self.qds.endTime - self.qds.startTime) // 3600)
        kept.active = tuple(o for o in self.model.outages if o.outserv == 0) if self.qds.iopt_maint else ()
        return kept

    def Load(self):
        pass

    def Release(self):
        pass

    def GetNumberOfRows(self):
        return self.rows

    def GetNumberOfColumns(self):
        return len(self.columns)

    def GetObject(self, column):
        return self.columns[column][0]

    def GetVariable(self, column):
        return self.columns[column][1]

    def GetUnit(self, column):
        return self.columns[column][2]

    def GetColumnValues(self, vector, column):
        if column == 0:
            vector.V = [float(h) for h in range(self.rows)]
        else:
            value = self.columns[column][3]
            vector.V = [value(t, self.active) for t in range(self.start, self.start + self.rows * 3600, 3600)]
        return 0


class Sub(PFObject):
    """One study time of a kept n-1 sweep: one row per contingency, one column per monitored branch and busbar."""

    def __init__(self, model, moment, active):
        super().__init__('sub', 'ElmRes', cnttime=moment)
        self.model = model
        branches = len(model.branches)
        self.moment, self.active = moment, active
        self.pre = [model.loading(i, moment, active) for i in range(branches)]
        off = {o.branch for o in active if o.starttime <= moment <= o.endtime}
        # A contingency whose branch a planned outage already switched off, or without a load-flow solution, has no row.
        self.rows = [j for j, b in enumerate(model.fault_branch) if b not in off and model.solvable(j, moment, active)]
        self.objects = model.branches + model.buses

    def Load(self):
        pass

    def Release(self):
        pass

    def GetNumberOfRows(self):
        return len(self.rows)

    def GetNumberOfColumns(self):
        return len(self.objects)

    def GetObject(self, column):
        return self.objects[column]

    def GetVariable(self, column):
        return 'c:loading' if column < len(self.model.branches) else 'm:u'

    def GetUnit(self, column):
        return '%' if column < len(self.model.branches) else 'p.u.'

    def GetObjectValue(self, row):
        return 0, self.model.faults[self.rows[row]]

    def GetColumnValues(self, _vector, _column):
        return 1  # sparse columns: the bridge reads them cell by cell, as it does for PowerFactory

    def GetValue(self, row, column):
        fault = self.rows[row]
        model, branches = self.model, len(self.model.branches)
        if column < branches:
            pre = self.pre[column]
            if not pre or model.fault_branch[fault] == column:
                return 3, 0.0
            post = model.n1_loading(column, fault, self.moment, self.active, pre)
            return (3, 0.0) if post < RECORDING_LOADING else (0, post)
        i = column - branches
        pre = self.pre[i] if i < branches else 0.0
        voltage = model.n1_voltage(i, fault, self.moment, self.active, pre)
        return (3, 0.0) if RECORDING_VOLTAGE[0] <= voltage <= RECORDING_VOLTAGE[1] else (0, voltage)


class Sweep(PFObject):
    def __init__(self, model, times, active):
        super().__init__('Kept n-1', 'ElmRes')
        self.model, self.times, self.active = model, times, active

    def GetContents(self, *_args):
        return [Sub(self.model, t, self.active) for t in self.times]


def synthetic_n1(model, bundle):
    """Kept n-1 and (n-1)' sweeps of every calculated case over its outage window, as main.py hands them over."""
    elements_of = {gl.object_key(f): {gl.object_key(model.branches[b])} for f, b in zip(model.faults, model.fault_branch)}
    entries = {}
    for plan in bundle['request']['cases']:
        if plan['status'] != gl.PLAN_READY:
            continue
        outages = [o for o in model.outages if gl.object_key(o) in {r['key'] for r in plan['members']}]
        times = sorted({t for o in outages for t in range(o.starttime - o.starttime % 3600, o.endtime + 1, 3600)})
        limits = {'loading': (RECORDING_LOADING,), 'voltage': RECORDING_VOLTAGE}
        entries[plan['id']] = {
            'status': 'CALCULATED', 'elements_of': elements_of, 'filtered_out': {},
            'reference': {'kept': Sweep(model, times, ()), 'window_times': times, 'recording_limits': limits},
            'scenario': {'kept': Sweep(model, times, tuple(outages)), 'window_times': times, 'recording_limits': limits},
        }
    return entries


def build(path, branches=330, cases=6, contingencies=100, window=120, spacing=None, model=None):
    """Run the synthetic PowerFactory run into `path`; `model` replaces the generated network (tests/ieee39.py)."""
    model = model or Model(branches, cases, contingencies, window, spacing)
    app = App(model.outages)
    app.qds.startTime, app.qds.endTime = YEAR_START, YEAR_START + 8760 * 3600
    app.qds.stepSize, app.qds.stepUnit = 1, 2
    app.qds.results = app.original_result = QdsResult(model, app.qds)
    gl.CASE_SOURCE = 'gui'
    gl.CASE_CONFIG_DIR = tempfile.mkdtemp()
    gl.GRID_NAME_FILTER = ''

    def case_manager(records, *_args, **_kwargs):
        config = gl.empty_case_config()
        # As the engineer sets it in Settings -> Run when there are more cases than the default allows.
        config['settings'] = {'max_cases': max(len(records), gl.MAX_CASES)}
        config['cases'] = [{'id': 'C%d' % (k + 1), 'name': record['name'], 'outages': [record['key']]}
                           for k, record in enumerate(records)]
        return config
    gl.run_case_manager = case_manager
    started = time.monotonic()

    def saved(done, total, detail, scenarios):
        print('  {:>3}/{} {:<28} {:6.1f} s{}'.format(done, total, detail, time.monotonic() - started,
                                                       '  <- dashboard opens here' if scenarios == 1 and detail.startswith('QDS C') else ''), flush=True)

    def consumer(bundle):
        print('PowerFactory part done (synthetic); importing:', flush=True)
        bundle['n1_runs'] = synthetic_n1(model, bundle) if model.faults else {}
        return bridge.import_results(bundle, path, saved)
    try:
        return gl.execute_outage_assessment(app, result_consumer=consumer)
    finally:
        gl.reset_settings()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--db', type=Path, default=ROOT / 'backend/data/synthetic-large.sqlite3')
    parser.add_argument('--branches', type=int, default=330, help='branches; as many busbars are added')
    parser.add_argument('--cases', type=int, default=6, help='planning cases, one planned outage each (at most {})'.format(gl.MAX_PLANNING_CASES))
    parser.add_argument('--contingencies', type=int, default=100)
    parser.add_argument('--window', type=int, default=120, help='hours of every planned outage (n-1 study times)')
    parser.add_argument('--spacing', type=int, default=None, help='hours between two planned outages (default: over the year)')
    args = parser.parse_args()
    path = args.db.expanduser().resolve()
    if path.exists():
        parser.error('{} exists; delete it or choose another --db.'.format(path))
    started = time.monotonic()
    outcome = build(path, args.branches, args.cases, args.contingencies, args.window, args.spacing)
    print('Done in {:.0f} s: {} cases, {:.0f} MB -> {}'.format(time.monotonic() - started, outcome['cases'],
                                                             path.stat().st_size / 1e6, path))
    print('Open it:  .venv/bin/python ../scripts/run_dashboard.py --db ' + str(path))


if __name__ == '__main__':
    main()
