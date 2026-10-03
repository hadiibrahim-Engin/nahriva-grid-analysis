"""Read-only across-scenarios aggregation of stored loading series and LODF values.

Nothing here writes to the database or changes how results are calculated. Per
line and scenario the loading is reduced to a few numbers; classification into
severity bands happens in the frontend (frontend/src/config/loadingBands.ts).

Definitions
- scenario value: maximum OUTAGE loading inside the scenario's outage windows.
- window base:    maximum REF loading inside the same windows (like for like).
- delta:          scenario value minus window base, in percentage points.
- base:           maximum REF loading over the full period (per line).
- hours_over:     time above each limit in the OUTAGE run, related to the whole
                  simulation period (not to the number of scenarios).
A line that is itself switched off in a scenario is flagged `outaged` and
carries no value for that scenario.

Equipment: branches (lines, transformers) are evaluated by loading. Busbars are
evaluated by voltage against the limits stored with the results (`buses`);
without stored limits no violation is derived.
"""

import json
from datetime import datetime, timezone

from app.simulation.store import outage_key

LOADING = "loading"
VOLTAGE = "voltage"
DEFAULT_LIMITS = (100.0, 110.0, 120.0)


def _iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def _window_clause(windows):
    if not windows:
        return "", []
    parts, params = [], []
    for start, end in windows:
        parts.append("(timestamp>=? AND timestamp<=?)")
        params += [_iso(start), _iso(end)]
    return " AND (" + " OR ".join(parts) + ")", params


def _extremes(db, run_id, windows=None):
    clause, params = _window_clause(windows)
    rows = db.execute(
        "SELECT element_id, MAX(value) hi FROM analysis_samples "
        "WHERE run_id=? AND metric_id=? AND value IS NOT NULL" + clause + " GROUP BY element_id",
        (run_id, LOADING, *params),
    )
    return {row["element_id"]: row["hi"] for row in rows}


def _voltage_range(db, run_id, windows=None):
    clause, params = _window_clause(windows)
    rows = db.execute(
        "SELECT element_id, MIN(value) lo, MAX(value) hi FROM analysis_samples "
        "WHERE run_id=? AND metric_id=? AND value IS NOT NULL" + clause + " GROUP BY element_id",
        (run_id, VOLTAGE, *params),
    )
    return {row["element_id"]: [row["lo"], row["hi"]] for row in rows}


def _voltage_limits(db, run_id):
    rows = db.execute(
        "SELECT element_id, lower, upper FROM pf_element_limits WHERE run_id=? AND metric_id=?",
        (run_id, VOLTAGE),
    )
    return {row["element_id"]: [row["lower"], row["upper"]] for row in rows}


def _voltage_unit(db, run_id):
    row = db.execute("SELECT unit FROM analysis_metrics WHERE run_id=? AND id=?", (run_id, VOLTAGE)).fetchone()
    return row["unit"] if row else None


def _hours_outside(db, run_id):
    """Per busbar: hours outside the stored voltage band over the whole simulation period."""
    rows = db.execute(
        "SELECT s.element_id, COUNT(*) n, MIN(s.timestamp) t0, MAX(s.timestamp) t1, "
        "SUM(CASE WHEN s.value < COALESCE(l.lower,-1e9) OR s.value > COALESCE(l.upper,1e9) THEN 1 ELSE 0 END) bad "
        "FROM analysis_samples s JOIN pf_element_limits l "
        "ON l.run_id=s.run_id AND l.element_id=s.element_id AND l.metric_id=s.metric_id "
        "WHERE s.run_id=? AND s.metric_id=? AND s.value IS NOT NULL GROUP BY s.element_id",
        (run_id, VOLTAGE),
    ).fetchall()
    result = {}
    for row in rows:
        step = 0.0
        if row["n"] > 1:
            span = datetime.fromisoformat(row["t1"]) - datetime.fromisoformat(row["t0"])
            step = span.total_seconds() / (row["n"] - 1) / 3600
        result[row["element_id"]] = (row["bad"] or 0) * step
    return result


def _hours_over(db, run_id, limits):
    """Per element: (hours above each limit, hours of the simulation period)."""
    case = ",".join("SUM(CASE WHEN value>? THEN 1 ELSE 0 END)" for _ in limits)
    rows = db.execute(
        "SELECT element_id, COUNT(*) n, MIN(timestamp) t0, MAX(timestamp) t1, " + case +
        " FROM analysis_samples WHERE run_id=? AND metric_id=? AND value IS NOT NULL GROUP BY element_id",
        (*limits, run_id, LOADING),
    ).fetchall()
    result = {}
    for row in rows:
        n = row["n"]
        step = 0.0
        if n > 1:
            span = datetime.fromisoformat(row["t1"]) - datetime.fromisoformat(row["t0"])
            step = span.total_seconds() / (n - 1) / 3600
        counts = [row[i] or 0 for i in range(4, 4 + len(limits))]
        result[row["element_id"]] = ([c * step for c in counts], n * step)
    return result


def across_scenarios(store, limits=DEFAULT_LIMITS):
    db = store.db
    catalog = store.catalog() or {"outages": []}
    outages = {o["id"]: o for o in catalog.get("outages", [])}

    # Newest scenario wins when a name was calculated more than once.
    seen, scenario_rows = set(), []
    for row in db.execute("SELECT * FROM pf_scenarios ORDER BY created_at DESC"):
        if row["name"] in seen:
            continue
        seen.add(row["name"])
        scenario_rows.append(row)
    scenario_rows.reverse()

    lodf = {}
    for row in db.execute("SELECT outage_key, element_id, lodf FROM pf_lodf"):
        lodf.setdefault(row["outage_key"], {})[row["element_id"]] = row["lodf"]

    period_hours = 0.0
    bus_info, bus_cells, bus_limits = {}, {}, {}
    voltage_unit = None
    names = {}  # element_id -> display info
    scenarios, values = [], {}  # values[element_id][scenario_id] = cell
    for row in scenario_rows:
        ids = json.loads(row["outages"])
        runs = {
            r["kind"]: r["run_id"]
            for r in db.execute(
                "SELECT run_id, kind FROM pf_scenario_runs WHERE scenario_id=?", (row["id"],)
            )
        }
        if "REF" not in runs or "OUTAGE" not in runs:
            continue
        chosen = [outages[i] for i in ids if i in outages]
        windows = [
            (o["start"], o["end"])
            for o in chosen
            if o.get("start") is not None and o.get("end") is not None
        ]
        equipment = {o["equipment_name"] for o in chosen if o.get("equipment_name")}
        elements = {
            e["id"]: e
            for e in db.execute(
                "SELECT id, name, className, type FROM analysis_elements WHERE run_id=?",
                (runs["OUTAGE"],),
            )
        }
        ref_full = _extremes(db, runs["REF"])
        ref_window = _extremes(db, runs["REF"], windows)
        out_window = _extremes(db, runs["OUTAGE"], windows)
        hours = _hours_over(db, runs["OUTAGE"], limits)
        scenario_lodf = lodf.get(outage_key(ids), {})
        volt_ref = _voltage_range(db, runs["REF"], windows)
        volt_out = _voltage_range(db, runs["OUTAGE"], windows)
        volt_hours = _hours_outside(db, runs["OUTAGE"])
        for element_id, band in _voltage_limits(db, runs["OUTAGE"]).items():
            bus_limits[element_id] = band
        voltage_unit = voltage_unit or _voltage_unit(db, runs["OUTAGE"])
        for element_id in volt_out:
            element = elements.get(element_id)
            if element is None:
                continue
            bus_info[element_id] = {
                "id": element_id,
                "name": element["name"],
                "class_name": element["className"],
                "type": element["type"],
            }
            bus_cells.setdefault(element_id, {})[row["id"]] = {
                "outaged": element["name"] in equipment,
                "ref": volt_ref.get(element_id),
                "out": volt_out[element_id],
                "hours_outside": volt_hours.get(element_id),
            }
        outaged_ids = []
        for element_id in ref_full:
            element = elements.get(element_id)
            if element is None:
                continue
            names[element_id] = {
                "id": element_id,
                "name": element["name"],
                "class_name": element["className"],
                "type": element["type"],
            }
            entry = values.setdefault(element_id, {"base": None, "cells": {}})
            if entry["base"] is None or ref_full[element_id] > entry["base"]:
                entry["base"] = ref_full[element_id]
            outaged = element["name"] in equipment
            if outaged:
                outaged_ids.append(element_id)
            value = out_window.get(element_id)
            base = ref_window.get(element_id)
            over, period = hours.get(element_id, (None, 0.0))
            period_hours = max(period_hours, period)
            entry["cells"][row["id"]] = {
                "outaged": outaged,
                "hours_over": None if outaged else over,
                "value": None if outaged else value,
                "window_base": base,
                "delta": None if outaged or value is None or base is None else value - base,
                "lodf": scenario_lodf.get(element_id),
            }
        scenarios.append(
            {
                "id": row["id"],
                "name": row["name"],
                "outages": [
                    {
                        "id": o["id"],
                        "name": o["name"],
                        "equipment_name": o.get("equipment_name"),
                        "start": o.get("start"),
                        "end": o.get("end"),
                    }
                    for o in chosen
                ],
                "outaged_element_ids": outaged_ids,
                "has_lodf": bool(scenario_lodf),
            }
        )

    lines = [
        {**names[element_id], "base": entry["base"], "cells": entry["cells"]}
        for element_id, entry in values.items()
        if names[element_id]["type"] != "bus"
    ]
    lines.sort(key=lambda line: line["name"].casefold())
    buses = [
        {**info, "unit": voltage_unit, "limits": bus_limits.get(element_id), "cells": bus_cells.get(element_id, {})}
        for element_id, info in bus_info.items()
    ]
    buses.sort(key=lambda bus: bus["name"].casefold())
    return {
        "scenarios": scenarios,
        "lines": lines,
        "buses": buses,
        "voltage_unit": voltage_unit,
        "has_lodf": any(s["has_lodf"] for s in scenarios),
        "period_hours": period_hours,
        "period": catalog.get("period"),
        "limits": list(limits),
    }


def scenario_profile(store, scenario_id, top=5, points=240):
    """Loading over time of the most critical branches of one scenario.

    The elements switched off in the scenario are left out. Series are reduced to at
    most `points` buckets by their maximum, so short peaks are never averaged away.
    """
    db = store.db
    row = db.execute("SELECT * FROM pf_scenarios WHERE id=?", (scenario_id,)).fetchone()
    if row is None:
        return None
    runs = {
        r["kind"]: r["run_id"]
        for r in db.execute("SELECT run_id, kind FROM pf_scenario_runs WHERE scenario_id=?", (scenario_id,))
    }
    if "REF" not in runs or "OUTAGE" not in runs:
        return None
    catalog = store.catalog() or {"outages": []}
    outages = {o["id"]: o for o in catalog.get("outages", [])}
    chosen = [outages[i] for i in json.loads(row["outages"]) if i in outages]
    windows = [(o["start"], o["end"]) for o in chosen if o.get("start") is not None and o.get("end") is not None]
    equipment = {o["equipment_name"] for o in chosen if o.get("equipment_name")}
    elements = {
        e["id"]: e
        for e in db.execute(
            "SELECT id, name, className, type FROM analysis_elements WHERE run_id=?", (runs["OUTAGE"],)
        )
        if e["type"] != "bus" and e["name"] not in equipment
    }
    peaks = _extremes(db, runs["OUTAGE"], windows)
    ranked = sorted((i for i in peaks if i in elements), key=lambda i: peaks[i], reverse=True)[: max(1, top)]
    if not ranked:
        return {"scenario_id": scenario_id, "times": [], "windows": windows, "series": []}

    marks = ",".join("?" for _ in ranked)

    def samples(run_id):
        result = {}
        for r in db.execute(
            "SELECT element_id, timestamp, value FROM analysis_samples WHERE run_id=? AND metric_id=? "
            "AND element_id IN (" + marks + ") ORDER BY timestamp",
            (run_id, LOADING, *ranked),
        ):
            result.setdefault(r["element_id"], []).append((r["timestamp"], r["value"]))
        return result

    out, ref = samples(runs["OUTAGE"]), samples(runs["REF"])
    stamps = [t for t, _ in out[ranked[0]]] if ranked[0] in out else []
    size = max(1, -(-len(stamps) // max(points, 1)))
    bucket_of = {t: i // size for i, t in enumerate(stamps)}
    times = [stamps[i] for i in range(0, len(stamps), size)]

    def reduce(pairs):
        buckets = [None] * len(times)
        for t, v in pairs:
            b = bucket_of.get(t)
            if b is not None and v is not None and (buckets[b] is None or v > buckets[b]):
                buckets[b] = v
        return buckets

    series = [
        {
            "id": i,
            "name": elements[i]["name"],
            "type": elements[i]["type"],
            "max": peaks[i],
            "out": reduce(out.get(i, [])),
            "ref": reduce(ref.get(i, [])),
        }
        for i in ranked
    ]
    return {"scenario_id": scenario_id, "times": times, "windows": windows, "series": series}
