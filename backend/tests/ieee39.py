"""The IEEE 39-bus transmission system (New England) as a synthetic run and a network map, for trying the dashboard.

Development only, never shipped. The topology (39 busbars, 34 lines, 12 transformers) is the public IEEE test
system; nominal voltages, areas, loadings and planned outages are made up. The run goes through the real path
(main.py runtime and dashboard bridge, see tests/large_dataset.py); only PowerFactory is replaced.

The map is an SVG as Figma exports it with "Include id attribute": every layer id is the layer name with spaces
replaced by underscores, and the equipment layers sit in a group named "Elements" (docs/MAP.md).

    cd backend
    .venv/bin/python -m tests.ieee39 --db data/ieee39-example/ieee39.sqlite3   (map: data/ieee39-example/maps/)
    ../scripts/try_example.sh                                                  (builds it and opens the dashboard)
"""

import argparse
import math
import time
from pathlib import Path

from tests import large_dataset
from tests.gridlens_fixture import PFObject, PlannedOutage
from tests.large_dataset import YEAR_START, Equipment, Model

LINES = (
    (1, 2), (1, 39), (2, 3), (2, 25), (3, 4), (3, 18), (4, 5), (4, 14), (5, 6), (5, 8), (6, 7), (6, 11), (7, 8),
    (8, 9), (9, 39), (10, 11), (10, 13), (13, 14), (14, 15), (15, 16), (16, 17), (16, 19), (16, 21), (16, 24),
    (17, 18), (17, 27), (21, 22), (22, 23), (23, 24), (25, 26), (26, 27), (26, 28), (26, 29), (28, 29),
)
TRANSFORMERS = ((2, 30), (6, 31), (10, 32), (11, 12), (12, 13), (19, 20), (19, 33), (20, 34), (22, 35), (23, 36),
                (25, 37), (29, 38))
GENERATOR_BUSES = (30, 31, 32, 33, 34, 35, 36, 37, 38, 39)
# Schematic position of every busbar on the map (x, y in px).
POSITIONS = {
    1: (110, 330), 2: (200, 200), 3: (310, 300), 4: (330, 440), 5: (320, 540), 6: (420, 580), 7: (300, 660),
    8: (200, 620), 9: (150, 730), 10: (600, 700), 11: (520, 620), 12: (470, 700), 13: (520, 540), 14: (460, 440),
    15: (560, 470), 16: (690, 380), 17: (560, 330), 18: (440, 260), 19: (690, 520), 20: (690, 640), 21: (820, 260),
    22: (960, 260), 23: (960, 400), 24: (820, 380), 25: (330, 110), 26: (560, 110), 27: (590, 230), 28: (780, 80),
    29: (930, 110), 30: (120, 110), 31: (420, 720), 32: (600, 790), 33: (820, 560), 34: (690, 760), 35: (1080, 260),
    36: (1080, 400), 37: (330, 30), 38: (1050, 60), 39: (70, 560),
}
WIDTH, HEIGHT = 1160, 830
AREAS = {
    "Area West": {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 25, 30, 31, 32, 37, 39},
    "Area East": {15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 33, 34, 35, 36},
    "Area North": {26, 27, 28, 29, 38},
}
# Planned outages: (branch name, day of the year), each for WINDOW hours.
# Within 75 days: the run covers the period of all outages (main.py), so this keeps the example small.
OUTAGES = (("Line 02 - 03", 25), ("Line 16 - 17", 40), ("Line 26 - 27", 55), ("Trf 12 - 13", 70),
           ("Line 04 - 14", 85), ("Line 21 - 22", 100))
WINDOW = 72


def bus_name(number):
    return "Bus %02d" % number


def branch_name(kind, a, b):
    return "%s %02d - %02d" % ("Line" if kind == "line" else "Trf", a, b)


def area_of(number):
    return next(area for area, members in AREAS.items() if number in members)


def kv_of(number):
    return 16.5 if number in GENERATOR_BUSES[:-1] else 138.0 if number == 12 else 230.0 if number == 20 else 345.0


# Loads of the IEEE 39-bus system (MW, bus -> base demand) and the generators with their share of the dispatch
# (MW at the base case); bus 39 is the equivalent of the neighbouring system, an external grid.
LOADS = {3: 322, 4: 500, 7: 233.8, 8: 522, 12: 7.5, 15: 320, 16: 329, 18: 158, 20: 628, 21: 274, 23: 247.5,
         24: 308.6, 25: 224, 26: 139, 27: 281, 28: 206, 29: 283.5, 31: 9.2, 39: 1104}
GENERATORS = {30: 250, 31: 520, 32: 650, 33: 632, 34: 508, 35: 650, 36: 560, 37: 540, 38: 830, 39: 1000}
SLACK = 39
# Series reactance (p.u.) of every line and transformer in the DC load flow, and the rating headroom: the base case
# peaks at about 80 % of a branch's rating, a planned outage pushes the branches that take its flow above 100 %.
X_LINE, X_TRAFO, HEADROOM = 0.02, 0.015, 0.8
# No 345 kV branch is rated below this (MW), so a lightly loaded line does not jump to several hundred percent.
MIN_RATING = 400.0


def _solve(matrix, vector):
    """Gauss-Jordan for the small DC systems of this example (no numpy on the PowerFactory side either)."""
    n = len(vector)
    a = [row[:] + [vector[k]] for k, row in enumerate(matrix)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(a[r][col]))
        a[col], a[pivot] = a[pivot], a[col]
        lead = a[col][col]
        a[col] = [v / lead for v in a[col]]
        for r in range(n):
            if r != col and a[r][col]:
                f = a[r][col]
                a[r] = [v - f * w for v, w in zip(a[r], a[col])]
    return [a[k][n] for k in range(n)]


class Ieee39(Model):
    """Model of tests/large_dataset.py with the IEEE 39-bus topology, its loads and generators and a DC load flow:
    branch flows, loadings, area balances and the flows between areas are consistent with each other."""

    def __init__(self, load=1.0):
        self.load_factor = load
        numbers = sorted(POSITIONS)
        self.index = {n: k for k, n in enumerate(numbers)}
        self.buses = [Equipment(bus_name(n), "ElmTerm", area_of(n), uknom=kv_of(n)) for n in numbers]
        bus = {n: self.buses[self.index[n]] for n in numbers}

        def cubicle(n):
            return PFObject("Cub_" + bus_name(n), "StaCubic", cterm=bus[n])

        self.ends = [("line", a, b) for a, b in LINES] + [("trafo", a, b) for a, b in TRANSFORMERS]
        self.branches = []
        for kind, a, b in self.ends:
            if kind == "line":
                ends = {"bus1": cubicle(a), "bus2": cubicle(b)}
            else:  # the first terminal of a transformer is its HV side
                high, low = (a, b) if kv_of(a) >= kv_of(b) else (b, a)
                ends = {"bushv": cubicle(high), "buslv": cubicle(low)}
            self.branches.append(Equipment(branch_name(kind, a, b), "ElmLne" if kind == "line" else "ElmTr2",
                                           area_of(a), uknom=kv_of(a), **ends))
        # Flow direction of each branch as PowerFactory reports m:P at its first terminal.
        self.first = [a if kind == "line" or kv_of(a) >= kv_of(b) else b for kind, a, b in self.ends]
        self.loads = [Equipment("Load %02d" % n, "ElmLod", area_of(n), bus1=cubicle(n)) for n in LOADS]
        self.sources = [Equipment("External grid %02d" % n if n == SLACK else "Gen %02d" % n,
                                  "ElmXnet" if n == SLACK else "ElmSym", area_of(n), bus1=cubicle(n)) for n in GENERATORS]
        self.faults = [PFObject(branch.loc_name, "ComOutage", outserv=0) for branch in self.branches]
        self.fault_branch = list(range(len(self.branches)))
        self._inverse, self._flows, self._lodfs = {}, {}, {}
        names = [branch.loc_name for branch in self.branches]
        self.outages = []
        for name, day in OUTAGES:
            branch = names.index(name)
            start = YEAR_START + day * 86400 + 6 * 3600
            outage = PlannedOutage("Maintenance " + name, equipment=[self.branches[branch]],
                                   starttime=start, endtime=start + WINDOW * 3600 - 1)
            outage.branch = branch
            self.outages.append(outage)
        # Ratings are properties of the equipment: taken from the base load (factor 1) over one week at its daily
        # peak, the same in every run, so a run with more load shows higher loadings.
        self.load_factor = 1.0
        peaks = [0.0] * len(self.ends)
        for hour in range(0, 7 * 24):
            for k, p in enumerate(self.flows(YEAR_START + 20 * 86400 + hour * 3600, ())):
                peaks[k] = max(peaks[k], abs(p))
        self.rating = [max(peak / HEADROOM, MIN_RATING) for peak in peaks]
        self.load_factor = load
        self._flows.clear()

    def demand(self, n, t):
        """Demand of the load at bus n: daily and seasonal swing, each bus a little shifted in time."""
        hour = (t - YEAR_START) / 3600
        swing = 1 + 0.15 * math.sin(2 * math.pi * (hour + n % 5) / 24) + 0.08 * math.cos(2 * math.pi * hour / 8760)
        return self.load_factor * LOADS[n] * swing

    def dispatch(self, n, t):
        """Output of the generator (or external grid) at bus n: its share of the total demand."""
        total = sum(self.demand(m, t) for m in LOADS)
        return total * GENERATORS[n] / sum(GENERATORS.values())

    def _off(self, t, active):
        return frozenset(o.branch for o in active if o.starttime <= t <= o.endtime)

    def _matrix(self, off):
        """Inverse of the DC susceptance matrix without the slack bus, per set of switched-off branches."""
        found = self._inverse.get(off)
        if found is None:
            size = len(self.index)
            b = [[0.0] * size for _ in range(size)]
            for k, (kind, x, y) in enumerate(self.ends):
                if k in off:
                    continue
                susceptance = 1 / (X_LINE if kind == "line" else X_TRAFO)
                i, j = self.index[x], self.index[y]
                b[i][i] += susceptance
                b[j][j] += susceptance
                b[i][j] -= susceptance
                b[j][i] -= susceptance
            keep = [k for k in range(size) if k != self.index[SLACK]]
            reduced = [[b[r][c] for c in keep] for r in keep]
            columns = [_solve(reduced, [1.0 if r == c else 0.0 for r in range(len(keep))]) for c in range(len(keep))]
            found = self._inverse[off] = (keep, [[columns[c][r] for c in range(len(keep))] for r in range(len(keep))])
        return found

    def flows(self, t, active):
        """Active power of every branch at its first terminal (MW) at time t."""
        off = self._off(t, active)
        key = (t, off)
        found = self._flows.get(key)
        if found is None:
            keep, inverse = self._matrix(off)
            injection = [0.0] * len(self.index)
            for n in GENERATORS:
                injection[self.index[n]] += self.dispatch(n, t)
            for n in LOADS:
                injection[self.index[n]] -= self.demand(n, t)
            p = [injection[k] for k in keep]
            angles = [0.0] * len(self.index)
            for r, k in enumerate(keep):
                angles[k] = sum(v * q for v, q in zip(inverse[r], p))
            found = []
            for k, (kind, x, y) in enumerate(self.ends):
                if k in off:
                    found.append(0.0)
                    continue
                flow = (angles[self.index[x]] - angles[self.index[y]]) / (X_LINE if kind == "line" else X_TRAFO)
                found.append(flow if self.first[k] == x else -flow)
            self._flows[key] = found
        return found

    def loading(self, i, t, active=()):
        return 100 * abs(self.flows(t, active)[i]) / self.rating[i]

    def _lodf(self, off):
        """Line outage distribution factors of the network without `off`: column k says how the flow of branch k
        moves to every other branch when k fails (None: the failure cuts off part of the network)."""
        found = self._lodfs.get(off)
        if found is None:
            keep, inverse = self._matrix(off)
            row = {bus: r for r, bus in enumerate(keep)}

            def z(a, b):  # bus impedance, zero at the slack bus
                return inverse[row[a]][row[b]] if a in row and b in row else 0.0

            buses = [(self.index[x], self.index[y], X_LINE if kind == "line" else X_TRAFO) for kind, x, y in self.ends]

            def ptdf(j, a, b):  # flow on branch j (x to y) per MW sent from bus a to bus b
                xj, yj, reactance = buses[j]
                return ((z(xj, a) - z(xj, b)) - (z(yj, a) - z(yj, b))) / reactance

            found = []
            for k, (xk, yk, _x) in enumerate(buses):
                denominator = 1 - ptdf(k, xk, yk)
                found.append(None if k in off or abs(denominator) < 1e-6 else
                             [0.0 if j == k else ptdf(j, xk, yk) / denominator for j in range(len(buses))])
            self._lodfs[off] = found
        return found

    def solvable(self, fault, moment, active):
        return self._lodf(self._off(moment, active))[self.fault_branch[fault]] is not None

    def n1_loading(self, i, fault, moment, active, pre):
        """DC load flow after the contingency: the flow of the failed branch spreads by its LODF."""
        k = self.fault_branch[fault]
        factors = self._lodf(self._off(moment, active))[k]
        flows = self.flows(moment, active)
        oriented = lambda j: flows[j] if self.first[j] == self.ends[j][1] else -flows[j]  # noqa: E731  (x to y)
        return 100 * abs(oriented(i) + factors[i] * oriented(k)) / self.rating[i]

    def n1_voltage(self, i, fault, moment, active, pre):
        """Voltage of busbar i after the contingency: falls with the loading of the branches at it."""
        number = sorted(POSITIONS)[i]
        k = self.fault_branch[fault]
        at = [j for j, (_kind, a, b) in enumerate(self.ends) if number in (a, b) and j != k]
        worst = max((self.n1_loading(j, fault, moment, active, None) for j in at), default=0.0)
        return 1.06 - 0.0009 * worst

    def voltage(self, i, t, active=()):
        """Voltage of busbar i: falls with the loading of the branches at it."""
        number = sorted(POSITIONS)[i]
        at = [k for k, (_kind, a, b) in enumerate(self.ends) if number in (a, b)]
        worst = max(self.loading(k, t, active) for k in at)
        return 1.06 - 0.0009 * worst

    def columns(self):
        """Loading and voltage as before, plus the active power of every load, generator and branch."""
        variable = ["m:P:bus1" if kind == "line" else "m:P:bushv" for kind, _a, _b in self.ends]
        return (super().columns()
                + [(e, "m:P:bus1", "MW", lambda t, a, n=n: self.demand(n, t)) for e, n in zip(self.loads, LOADS)]
                + [(e, "m:P:bus1", "MW", lambda t, a, n=n: self.dispatch(n, t)) for e, n in zip(self.sources, GENERATORS)]
                + [(b, v, "MW", lambda t, a, k=k: self.flows(t, a)[k])
                   for k, (b, v) in enumerate(zip(self.branches, variable))])


def map_svg():
    """The network map as Figma exports it: equipment layers in the group "Elements", the rest is drawing."""
    def fid(name):
        return name.replace(" ", "_")

    def xy(n):
        return POSITIONS[n]

    lines, trafos, buses, labels, generators = [], [], [], [], []
    for a, b in LINES:
        (x1, y1), (x2, y2) = xy(a), xy(b)
        lines.append(f'<path id="{fid(branch_name("line", a, b))}" d="M{x1} {y1}L{x2} {y2}" '
                     'stroke="#475569" stroke-width="3"/>')
    for a, b in TRANSFORMERS:
        (x1, y1), (x2, y2) = xy(a), xy(b)
        length = math.hypot(x2 - x1, y2 - y1)
        ux, uy = (x2 - x1) / length, (y2 - y1) / length
        mx, my = (x1 + x2) / 2, (y1 + y2) / 2
        c1, c2 = (mx - 6 * ux, my - 6 * uy), (mx + 6 * ux, my + 6 * uy)
        e1, e2 = (c1[0] - 10 * ux, c1[1] - 10 * uy), (c2[0] + 10 * ux, c2[1] + 10 * uy)
        trafos.append(
            f'<g id="{fid(branch_name("trafo", a, b))}">'
            f'<path d="M{x1} {y1}L{e1[0]:.1f} {e1[1]:.1f}" stroke="#475569" stroke-width="3"/>'
            f'<path d="M{e2[0]:.1f} {e2[1]:.1f}L{x2} {y2}" stroke="#475569" stroke-width="3"/>'
            f'<circle cx="{c1[0]:.1f}" cy="{c1[1]:.1f}" r="10" fill="white" stroke="#475569" stroke-width="2.5"/>'
            f'<circle cx="{c2[0]:.1f}" cy="{c2[1]:.1f}" r="10" fill="white" fill-opacity="0" stroke="#475569" stroke-width="2.5"/>'
            '</g>')
    for n in sorted(POSITIONS):
        x, y = xy(n)
        buses.append(f'<rect id="{fid(bus_name(n))}" x="{x - 22}" y="{y - 4}" width="44" height="8" rx="2" fill="#0F172A"/>')
        labels.append(f'<text x="{x + 26}" y="{y - 8}" font-family="Inter" font-size="11" fill="#334155">{n:02d}</text>')
    for number, n in enumerate(GENERATOR_BUSES, start=1):
        x, y = xy(n)
        gy = y + 34 if n not in (37, 38, 30) else y - 34
        name = 'External grid %02d' % n if n == SLACK else 'Gen %02d' % n
        generators.append(f'<g id="{fid(name)}"><path d="M{x} {y}L{x} {gy}" stroke="#94A3B8" stroke-width="2"/>'
                          f'<circle cx="{x}" cy="{gy}" r="12" fill="white" stroke="#94A3B8" stroke-width="2"/>'
                          f'<text x="{x - 7}" y="{gy + 4}" font-family="Inter" font-size="10" fill="#64748B">G{number}</text></g>')
    return (
        f'<svg width="{WIDTH}" height="{HEIGHT}" viewBox="-40 -40 {WIDTH+80} {HEIGHT+80}" fill="none" '
        'xmlns="http://www.w3.org/2000/svg">\n'
        f'<g id="IEEE_39-bus_transmission_system">\n<rect id="Background" width="{WIDTH}" height="{HEIGHT}" fill="white"/>\n'
        '<g id="Generators">' + "".join(generators) + '</g>\n'
        '<g id="Elements">\n' + "\n".join(lines + trafos + buses) + '\n</g>\n'
        '<g id="Labels">' + "".join(labels) + '</g>\n</g>\n</svg>\n'
    )


# Two runs, as two PowerFactory runs of the same study case: the base case and one with 6 % more load, so the
# analysis browser has two analyses to compare.
RUNS = (1.0, 1.06)


def build(path, map_path=None, runs=RUNS):
    """The example database (one analysis per entry of `runs`, the load factor) and its map. Returns the outcome of
    the last run."""
    for load in runs:
        outcome = large_dataset.build(path, model=Ieee39(load))
    if map_path:
        map_path.parent.mkdir(parents=True, exist_ok=True)
        map_path.write_text(map_svg(), encoding="utf-8")
    return outcome


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", type=Path, default=large_dataset.ROOT / "backend/data/ieee39-example/ieee39.sqlite3")
    args = parser.parse_args()
    path = args.db.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        parser.error(f"{path} exists; delete it or choose another --db.")
    started = time.monotonic()
    outcome = build(path, path.parent / "maps" / "ieee39.svg")
    print(f"Done in {time.monotonic() - started:.0f} s: {len(RUNS)} analyses of {outcome['cases']} cases -> {path}")
    print(f"Map: {path.parent / 'maps' / 'ieee39.svg'}")


if __name__ == "__main__":
    main()
