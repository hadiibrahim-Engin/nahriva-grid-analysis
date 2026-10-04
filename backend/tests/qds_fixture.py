"""Small, explicitly synthetic QDS result database; test fixture only, never shipped."""

from datetime import datetime, timedelta, timezone
import math
from pathlib import Path

from app.simulation.store import ScenarioStore, catalog_signature, outage_key

START = datetime(2026, 1, 31, tzinfo=timezone.utc)
STEPS = 672  # 7 complete days at 15-minute steps, outside today's date window
DUMMY_VERSION = 2  # 1: three scenarios, five elements; files of version 1 stay readable
# (id, name, class, type, path, daily peak loading in %, relative rating)
LINES = [
    ("line-north", "Line North–West", "ElmLne", "line", "Dummy/Line North", 70, 1.0),
    ("line-south", "Line Central–South", "ElmLne", "line", "Dummy/Line South", 82, 1.0),
    ("transformer-north", "Transformer North T1", "ElmTr2", "transformer", "Dummy/Transformer North", 66, 1.5),
    ("line-east", "Line East–Central", "ElmLne", "line", "Dummy/Line East", 55, 0.8),
    ("line-west", "Line West–Central", "ElmLne", "line", "Dummy/Line West", 62, 0.8),
    ("line-southeast", "Line South–East", "ElmLne", "line", "Dummy/Line South-East", 25, 1.2),
    ("line-northeast", "Line North–East", "ElmLne", "line", "Dummy/Line North-East", 64, 0.6),
    ("line-southwest", "Line South–West", "ElmLne", "line", "Dummy/Line South-West", 87, 0.7),
    ("line-ring", "Line Central Ring", "ElmLne", "line", "Dummy/Line Ring", 88, 1.0),
    ("transformer-south", "Transformer South T2", "ElmTr2", "transformer", "Dummy/Transformer South", 74, 1.5),
]
BUSES = [
    ("bus-north", "Busbar North", "ElmTerm", "bus", "Dummy/Bus North"),
    ("bus-south", "Busbar South", "ElmTerm", "bus", "Dummy/Bus South"),
    ("bus-east", "Busbar East", "ElmTerm", "bus", "Dummy/Bus East"),
]
# Voltage in p.u.: base level per busbar and the shift when a branch is switched off.
BUS_OFFSET = {"bus-north": 0.0, "bus-south": 0.0, "bus-east": 0.012}
VOLT_SHIFT = {
    "line-north": {"bus-north": -0.012},
    "transformer-north": {"bus-north": -0.03, "bus-south": -0.02},
    "line-south": {"bus-south": -0.08},  # ends close to the lower limit of 0.90 p.u.
    "line-east": {"bus-east": 0.075},  # leaves the band above 1.10 p.u.
    "line-west": {"bus-north": -0.015},
    "transformer-south": {"bus-south": -0.115, "bus-north": -0.02},  # leaves the band below 0.90 p.u.
}
ELEMENTS = [line[:5] for line in LINES] + BUSES
PEAK = {line[0]: line[5] for line in LINES}
RATING = {line[0]: line[6] for line in LINES}
METRICS = [
    ("loading", "Loading", "%", None, 100),
    ("voltage", "Voltage", "p.u.", 0.9, 1.1),
    ("active_power", "Active power", "MW", None, None),
    ("reactive_power", "Reactive power", "Mvar", None, None),
    ("current", "Current", "A", None, None),
]
# (id, name, switched-off element, first day, last day)
OUTAGES = [
    ("outage-line", "Outage Line North", "line-north", 2, 3),
    ("outage-transformer", "Outage Transformer North", "transformer-north", 4, 5),
    ("outage-south", "Outage Line South", "line-south", 1, 2),
    ("outage-east", "Outage Line East", "line-east", 3, 4),
    ("outage-west", "Outage Line West", "line-west", 5, 6),
    ("outage-southeast", "Outage Line South-East", "line-southeast", 0, 1),
    ("outage-transformer-south", "Outage Transformer South", "transformer-south", 3, 4),
]
SCENARIOS = [
    ("Outage Line North", ["outage-line"]),
    ("Outage Transformer North", ["outage-transformer"]),
    ("Outage North combined", ["outage-line", "outage-transformer"]),
    ("Outage Line South", ["outage-south"]),
    ("Outage Line East", ["outage-east"]),
    ("Outage West and South-East", ["outage-west", "outage-southeast"]),
    ("Outage Transformer South", ["outage-transformer-south"]),
    ("Outage Line South-East", ["outage-southeast"]),
]
# LODF[switched-off element][monitored line]: share of the lost flow taken over.
LODF = {
    "line-north": {"line-east": 0.10, "line-west": 0.30, "line-northeast": 0.55, "line-southwest": 0.22, "line-ring": 0.05},
    "transformer-north": {"line-southwest": 0.06, "line-southeast": 0.35, "line-ring": 0.04, "line-south": 0.10, "transformer-south": 0.15},
    "line-south": {"line-southwest": 0.30, "line-east": 0.25, "line-north": 0.20, "line-ring": 0.06, "line-southeast": 0.10, "line-west": 0.15, "transformer-south": 0.12},
    "line-east": {"line-south": 0.30, "line-southwest": 0.15, "line-west": 0.20, "line-southeast": 0.30, "line-ring": 0.03},
    "line-west": {"line-south": 0.35, "line-southwest": 0.10, "line-north": 0.20, "line-east": 0.30, "line-northeast": 0.15},
    "line-southeast": {"line-northeast": 0.20, "line-southwest": 0.12, "line-south": 0.10},
    "transformer-south": {"line-south": 0.30, "line-southeast": 0.28, "line-southwest": 0.22, "transformer-north": 0.12, "line-ring": 0.05, "line-east": 0.08},
}


def flow(element_id):
    """Peak flow in rating units: loading in % times the relative rating."""
    return PEAK[element_id] * RATING[element_id]


def shift(switched_off, monitored):
    """Loading change in percentage points at the daily peak."""
    return LODF[switched_off].get(monitored, 0.0) * flow(switched_off) / RATING[monitored]


def lodf_rows(outages_by_id, scenarios):
    """(outage_key, element_id, lodf, p_pre, p_post) for every scenario and monitored line."""
    rows = []
    for _name, ids in scenarios:
        off = [outages_by_id[i]["element"] for i in ids]
        for line in LINES:
            if line[0] in off:
                continue
            lost = sum(flow(k) for k in off)
            lodf = sum(LODF[k].get(line[0], 0.0) * flow(k) for k in off) / lost
            p_pre = flow(line[0])
            rows.append((outage_key(ids), line[0], lodf, p_pre, p_pre + lodf * lost))
    return rows


def create_dummy_database(path):
    path = Path(path).expanduser().resolve()
    store = ScenarioStore(str(path))
    try:
        catalog = store.catalog()
        has_data = store.db.execute("SELECT 1 FROM analysis_runs LIMIT 1").fetchone()
        if has_data:
            if not catalog or catalog.get("dummy_qds_version") not in (1, DUMMY_VERSION):
                raise ValueError(
                    "This file contains other results. Use a separate database for the dummy QDS data: "
                    + str(path)
                )
            return path
        end = START + timedelta(minutes=15 * (STEPS - 1))
        outages = [
            {
                "id": identifier,
                "name": name,
                "path": "Dummy/" + name + ".IntPlannedout",
                "equipment_name": next(e[1] for e in ELEMENTS if e[0] == element),
                "start": int((START + timedelta(days=first)).timestamp()),
                "end": int((START + timedelta(days=last)).timestamp()),
                "ignored": False,
                "in_period": True,
                "element": element,
            }
            for identifier, name, element, first, last in OUTAGES
        ]
        by_id = {o["id"]: o for o in outages}
        catalog = {
            "project": "Dummy QDS · synthetic test data",
            "project_path": "Dummy.IntPrj",
            "study_case": "7 days · 15 minutes",
            "study_case_path": "Dummy.IntCase",
            "period": [int(START.timestamp()), int(end.timestamp())],
            "outages": outages,
            "dummy_qds_version": DUMMY_VERSION,
            "data_source": "synthetic",
            "powerfactory_version": None,
            "sample_interval_seconds": 900,
        }
        store.publish_catalog(catalog)
        # LODF belongs before any simulation, exactly like the PowerFactory script.
        store.save_lodf(lodf_rows(by_id, SCENARIOS))
        for name, ids in SCENARIOS:
            store.enqueue(
                "run",
                {
                    "name": name,
                    "outage_ids": ids,
                    "catalog_signature": catalog_signature(catalog),
                },
            )
            job = store.claim()
            runs = []
            for kind in ("REF", "OUTAGE"):
                samples = []
                for step in range(STEPS):
                    timestamp = START + timedelta(minutes=15 * step)
                    epoch = timestamp.timestamp()
                    hour = (step % 96) / 4
                    daily = (math.sin((hour - 8) / 24 * 2 * math.pi) + 1) / 2
                    shape = 0.45 + 0.55 * daily
                    active = [
                        by_id[i]
                        for i in ids
                        if kind == "OUTAGE" and by_id[i]["start"] <= epoch < by_id[i]["end"]
                    ]
                    off = {o["element"] for o in active}
                    for element in ELEMENTS:
                        eid, bus = element[0], element[3] == "bus"
                        if bus:
                            loading = 0.0
                            voltage = (
                                1.02 + BUS_OFFSET[eid] - daily * 0.025
                                + sum(VOLT_SHIFT.get(k, {}).get(eid, 0.0) for k in off)
                            )
                        elif eid in off:
                            loading = 0.0
                        else:
                            loading = (
                                PEAK[eid] + sum(shift(k, eid) for k in off)
                            ) * shape
                        values = {
                            "loading": loading,
                            "active_power": loading * 0.32,
                            "reactive_power": loading * 0.08,
                            "current": loading * 3.2,
                        }
                        if bus:
                            values = {"voltage": voltage}
                        for metric in METRICS:
                            if metric[0] not in values:
                                continue
                            samples.append(
                                (
                                    eid,
                                    metric[0],
                                    int(epoch),
                                    round(values[metric[0]], 6),
                                )
                            )
                runs.append(
                    {
                        "kind": kind,
                        "source": "Dummy QDS (synthetic)",
                        "elements": ELEMENTS,
                        "metrics": METRICS,
                        "samples": samples,
                        "limits": [
                            (e[0], "voltage", 0.9, 1.1)
                            for e in ELEMENTS
                            if e[3] == "bus"
                        ],
                    }
                )
            store.save_scenario(job, catalog, runs)
        return path
    finally:
        store.close()

