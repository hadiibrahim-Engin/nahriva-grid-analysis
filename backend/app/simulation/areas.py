"""Load, generation and transit per area (grid), from the active power PowerFactory recorded. Read-only for the API.

What PowerFactory records is the engineer's choice (ComStatsim > Result Variables). The analysis works with what
is there and says what is missing:

- balance per area needs the active power of loads (m:P:bus1 of ElmLod) and of generators or external grids
  (m:P:bus1 of ElmSym, ElmGenstat, ElmPvsys, ElmXnet);
- flows between areas and transit need the active power of the branches that connect two areas (m:P:bus1 of
  ElmLne, m:P:bushv of ElmTr2/ElmTr3) and the areas of their two ends, which the bridge reads at import.

An area is the grid (ElmNet) of an element; a branch connects the grids of its two terminals. The bridge sums the
values per area and time while it imports a run (`AreaTimes`), so a request reads hundreds of rows, never the raw
series. Signs as PowerFactory reports them: loads positive when consuming, generators and external grids positive
when feeding in, a branch positive when power flows from its first terminal (bus1/bushv) into the branch.
"""

from collections import defaultdict
from itertools import repeat
from operator import add

from app.simulation import across, states, timepoint

LOAD_CLASSES = {"ElmLod", "ElmLodlv", "ElmLodmv", "ElmLodlvp"}
GENERATOR_CLASSES = {"ElmSym", "ElmGenstat", "ElmPvsys"}
EXTERNAL_CLASSES = {"ElmXnet"}
METRIC = "active_power"
STATES_VERSION = states.STATES_VERSION



def category(class_name):
    """'load', 'generator' or 'external' for the elements whose active power makes up an area balance."""
    return ("load" if class_name in LOAD_CLASSES else "generator" if class_name in GENERATOR_CLASSES
            else "external" if class_name in EXTERNAL_CLASSES else None)


class AreaTimes:
    """Sums the active power of one run per area and time while the bridge imports it (C-level list maps)."""

    def __init__(self, rows):
        self.rows = rows
        self.sums = {}  # (area, kind) -> list
        self.missing = {}  # area -> list of counts
        self.flows = {}  # (from_area, to_area) -> list

    def _add(self, store, key, values):
        clean = [0.0 if v is None else v for v in values]
        found = store.get(key)
        store[key] = clean if found is None else list(map(add, found, clean))

    def add(self, kind, area, values, ends=None):
        """One series of active power: of a load, generator or external grid in `area`, or of a branch whose ends
        lie in the areas `ends` = (first terminal, second terminal)."""
        if kind in ("load", "generator", "external"):
            self._add(self.sums, (area, kind), values)
            gaps = [1 if v is None else 0 for v in values]
            self._add(self.missing, area, gaps)
        elif ends and ends[0] and ends[1] and ends[0] != ends[1]:
            low, high = sorted(ends)
            signed = values if ends[0] == low else [None if v is None else -v for v in values]
            self._add(self.flows, (low, high), signed)

    def store(self, db, run_id, timestamps):
        areas = sorted({area for area, _kind in self.sums})
        for area in areas:
            columns = [self.sums.get((area, kind)) for kind in ("load", "generator", "external")]
            missing = self.missing.get(area) or list(repeat(0, self.rows))
            db.executemany("INSERT INTO pf_area_times VALUES(?,?,?,?,?,?,?)", (
                (run_id, area, t, *(None if c is None else c[i] for c in columns), int(missing[i]))
                for i, t in enumerate(timestamps)))
        for (low, high), values in self.flows.items():
            db.executemany("INSERT INTO pf_area_flows VALUES(?,?,?,?,?)",
                           ((run_id, low, high, t, v) for t, v in zip(timestamps, values)))


def capability(db, run_id):
    """What the recorded data of a run allows: the balance per area, the flows between areas, and what is missing."""
    counts = dict(db.execute(
        "SELECT e.className, COUNT(*) FROM analysis_series se JOIN analysis_elements e "
        "ON e.run_id = se.run_id AND e.id = se.element_id WHERE se.run_id = ? AND se.metric_id = ? "
        "GROUP BY e.className", (run_id, METRIC)).fetchall())
    loads = sum(n for c, n in counts.items() if c in LOAD_CLASSES)
    sources = sum(n for c, n in counts.items() if c in GENERATOR_CLASSES | EXTERNAL_CLASSES)
    branches = sum(n for c, n in counts.items() if c in ("ElmLne", "ElmTr2", "ElmTr3"))
    summarised = db.execute("SELECT 1 FROM pf_area_times WHERE run_id = ? LIMIT 1", (run_id,)).fetchone() is not None
    pairs = db.execute("SELECT COUNT(DISTINCT from_area || '|' || to_area) FROM pf_area_flows WHERE run_id = ?",
                       (run_id,)).fetchone()[0]
    missing = []
    if not loads:
        missing.append("active power of loads (m:P:bus1 of ElmLod)")
    if not sources:
        missing.append("active power of generators or external grids (m:P:bus1 of ElmSym, ElmGenstat, ElmPvsys, ElmXnet)")
    if not branches:
        missing.append("active power of lines and transformers (m:P:bus1 of ElmLne, m:P:bushv of ElmTr2/ElmTr3)")
    balance = bool(loads and sources and summarised)
    notes = []
    if loads and sources and not summarised:
        notes.append("The run was imported before the area summary existed; calculate it again to evaluate areas.")
    if branches and summarised and not pairs:
        notes.append("No recorded branch connects two areas, so there are no flows between areas.")
    return {
        "balance": balance,
        "flows": bool(balance and pairs),
        "missing": missing,
        "notes": notes,
        "recorded": {"loads": loads, "sources": sources, "branches": branches},
    }


def _read(db, run_id, start, end):
    window = "AND t >= ? AND t <= ?"
    bounds = (start if start is not None else -2 ** 62, end if end is not None else 2 ** 62)
    times = defaultdict(dict)
    for area, t, load, generation, external, missing in db.execute(
            f"SELECT area, t, load, generation, external, missing FROM pf_area_times WHERE run_id = ? {window} "
            "ORDER BY area, t", (run_id, *bounds)):
        times[area][t] = (load, generation, external, missing)
    flows = defaultdict(dict)
    for low, high, t, p in db.execute(
            f"SELECT from_area, to_area, t, p FROM pf_area_flows WHERE run_id = ? {window}", (run_id, *bounds)):
        flows[(low, high)][t] = p
    return times, flows


def _series(times, flows):
    """Per area and time: load, generation (incl. external grids), net (generation - load), import, export,
    transit (power that only passes through: the smaller of import and export)."""
    stamps = sorted({t for per in times.values() for t in per})
    result = {}
    for area, per in times.items():
        load = [per.get(t, (None,) * 4)[0] for t in stamps]
        generation = [None if t not in per else ((per[t][1] or 0.0) + (per[t][2] or 0.0)
                                                 if per[t][1] is not None or per[t][2] is not None else None)
                      for t in stamps]
        imported, exported = [0.0] * len(stamps), [0.0] * len(stamps)
        for (low, high), values in flows.items():
            if area not in (low, high):
                continue
            for i, t in enumerate(stamps):
                p = values.get(t)
                if p is None:
                    continue
                inbound = p if area == high else -p  # positive p flows from low to high
                if inbound > 0:
                    imported[i] += inbound
                else:
                    exported[i] -= inbound
        result[area] = {
            "load": load,
            "generation": generation,
            "net": [None if g is None and lo is None else (g or 0.0) - (lo or 0.0) for g, lo in zip(generation, load)],
            "import": imported,
            "export": exported,
            "transit": [min(i, e) for i, e in zip(imported, exported)],
            "missing": [per.get(t, (0, 0, 0, 0))[3] for t in stamps],
        }
    return stamps, result


def _finite(values):
    return [v for v in values if v is not None]


def _summary(series):
    def stat(values, pick):
        found = _finite(values)
        return pick(found) if found else None
    mean = lambda values: sum(values) / len(values)  # noqa: E731
    return {
        "load_mean": stat(series["load"], mean), "load_peak": stat(series["load"], max),
        "generation_mean": stat(series["generation"], mean), "generation_peak": stat(series["generation"], max),
        "net_mean": stat(series["net"], mean), "net_min": stat(series["net"], min), "net_max": stat(series["net"], max),
        "import_peak": stat(series["import"], max), "export_peak": stat(series["export"], max),
        "transit_mean": stat(series["transit"], mean), "transit_peak": stat(series["transit"], max),
        "missing_times": sum(1 for m in series["missing"] if m),
    }


def _reduce(stamps, series, points):
    """At most `points` intervals per area: the highest load, generation, import and transit and the lowest and
    highest net of each interval (peaks survive, never a mean)."""
    size = max(1, -(-len(stamps) // points))
    out = {}
    for area, s in series.items():
        def pick(values, fn):
            return [fn(_finite(values[i:i + size])) if _finite(values[i:i + size]) else None
                    for i in range(0, len(stamps), size)]
        out[area] = {"load": pick(s["load"], max), "generation": pick(s["generation"], max),
                     "net_min": pick(s["net"], min), "net_max": pick(s["net"], max),
                     "import": pick(s["import"], max), "export": pick(s["export"], max),
                     "transit": pick(s["transit"], max)}
    return stamps[::size], size, out


def _days(stamps, series):
    """Per area and UTC day: lowest, mean and highest net and the highest load (for the area-by-day heat map)."""
    days = sorted({t - t % 86400 for t in stamps})
    index = {day: i for i, day in enumerate(days)}
    out = {}
    for area, s in series.items():
        buckets = [[] for _ in days]
        loads = [[] for _ in days]
        for t, net, load in zip(stamps, s["net"], s["load"]):
            if net is not None:
                buckets[index[t - t % 86400]].append(net)
            if load is not None:
                loads[index[t - t % 86400]].append(load)
        out[area] = {"net_mean": [sum(b) / len(b) if b else None for b in buckets],
                     "net_min": [min(b) if b else None for b in buckets],
                     "net_max": [max(b) if b else None for b in buckets],
                     "load_max": [max(b) if b else None for b in loads]}
    return days, out


def _pairs(flows, stamps):
    out = []
    for (low, high), values in sorted(flows.items()):
        found = [values[t] for t in stamps if t in values]
        if not found:
            continue
        strongest = max(found, key=abs)
        out.append({"from": low, "to": high, "mean": sum(found) / len(found), "peak": strongest,
                    "share_forward": sum(1 for p in found if p > 0) / len(found)})
    return out


def area_view(store, scenario_id, start=None, end=None, points=1500):
    """Load, generation, net, flows and transit per area of a scenario run and its REF, in a time range.

    None for an unknown scenario. When the recorded data does not allow it, `capability` says what is missing and
    the numbers are left out.
    """
    row, runs = timepoint._scenario(store, scenario_id)
    if row is None:
        return None
    db = store.db
    able = capability(db, runs["OUTAGE"])
    result = {"scenario_id": scenario_id, "capability": able, "unit": "MW", "states_version": STATES_VERSION}
    if not able["balance"]:
        return result
    _ids, _chosen, windows, _equipment = across._outage_context(store, row)
    views = {}
    for kind in ("OUTAGE", "REF"):
        if kind not in runs or not capability(db, runs[kind])["balance"]:
            continue
        times, flows = _read(db, runs[kind], start, end)
        stamps, series = _series(times, flows)
        views[kind] = (stamps, series, flows)
    stamps, series, flows = views["OUTAGE"]
    shown, steps, course = _reduce(stamps, series, points)
    days, daily = _days(stamps, series)
    reference = views.get("REF")
    areas = []
    for area in sorted(series):
        entry = {"area": area, **_summary(series[area])}
        if reference and area in reference[1]:
            entry["ref"] = _summary(reference[1][area])
        areas.append(entry)
    return {
        **result,
        "windows": windows,
        "areas": areas,
        "times": shown,
        "interval_steps": steps,
        "course": course,
        "days": days,
        "daily": daily,
        "flows": _pairs(flows, stamps),
        "flows_ref": _pairs(reference[2], reference[0]) if reference else [],
    }
