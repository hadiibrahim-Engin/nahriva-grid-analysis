"""Small, persistent and explicitly synthetic QDS result database for Mac testing."""

import argparse
from datetime import datetime, timedelta, timezone
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.simulation.store import ScenarioStore, catalog_signature, outage_key

START = datetime(2026, 1, 31, tzinfo=timezone.utc)
STEPS = 672  # 7 complete days at 15-minute steps, outside today's date window
DUMMY_VERSION = 2  # 1: three scenarios, five elements; files of version 1 stay readable
# (id, name, class, type, path, daily peak loading in %, relative rating)
LINES = [
    ("line-nord", "Leitung Nord–West", "ElmLne", "line", "Dummy/Leitung Nord", 70, 1.0),
    ("line-sued", "Leitung Mitte–Süd", "ElmLne", "line", "Dummy/Leitung Süd", 82, 1.0),
    ("trafo-nord", "Trafo Nord T1", "ElmTr2", "transformer", "Dummy/Trafo Nord", 66, 1.5),
    ("line-ost", "Leitung Ost–Mitte", "ElmLne", "line", "Dummy/Leitung Ost", 55, 0.8),
    ("line-west", "Leitung West–Mitte", "ElmLne", "line", "Dummy/Leitung West", 62, 0.8),
    ("line-suedost", "Leitung Süd–Ost", "ElmLne", "line", "Dummy/Leitung Süd-Ost", 25, 1.2),
    ("line-nordost", "Leitung Nord–Ost", "ElmLne", "line", "Dummy/Leitung Nord-Ost", 64, 0.6),
    ("line-suedwest", "Leitung Süd–West", "ElmLne", "line", "Dummy/Leitung Süd-West", 87, 0.7),
    ("line-ring", "Leitung Ring Mitte", "ElmLne", "line", "Dummy/Leitung Ring", 88, 1.0),
    ("trafo-sued", "Trafo Süd T2", "ElmTr2", "transformer", "Dummy/Trafo Süd", 74, 1.5),
]
BUSES = [
    ("bus-nord", "Sammelschiene Nord", "ElmTerm", "bus", "Dummy/Bus Nord"),
    ("bus-sued", "Sammelschiene Süd", "ElmTerm", "bus", "Dummy/Bus Süd"),
    ("bus-ost", "Sammelschiene Ost", "ElmTerm", "bus", "Dummy/Bus Ost"),
]
# Voltage in p.u.: base level per busbar and the shift when a branch is switched off.
BUS_OFFSET = {"bus-nord": 0.0, "bus-sued": 0.0, "bus-ost": 0.012}
VOLT_SHIFT = {
    "line-nord": {"bus-nord": -0.012},
    "trafo-nord": {"bus-nord": -0.03, "bus-sued": -0.02},
    "line-sued": {"bus-sued": -0.08},  # ends close to the lower limit of 0.90 p.u.
    "line-ost": {"bus-ost": 0.075},  # leaves the band above 1.10 p.u.
    "line-west": {"bus-nord": -0.015},
    "trafo-sued": {"bus-sued": -0.115, "bus-nord": -0.02},  # leaves the band below 0.90 p.u.
}
ELEMENTS = [line[:5] for line in LINES] + BUSES
PEAK = {line[0]: line[5] for line in LINES}
RATING = {line[0]: line[6] for line in LINES}
METRICS = [
    ("loading", "Auslastung", "%", None, 100),
    ("voltage", "Spannung", "p.u.", 0.9, 1.1),
    ("active_power", "Wirkleistung", "MW", None, None),
    ("reactive_power", "Blindleistung", "Mvar", None, None),
    ("current", "Strom", "A", None, None),
]
# (id, name, switched-off element, first day, last day)
OUTAGES = [
    ("outage-line", "Freischaltung Leitung Nord", "line-nord", 2, 3),
    ("outage-trafo", "Freischaltung Trafo Nord", "trafo-nord", 4, 5),
    ("outage-sued", "Freischaltung Leitung Süd", "line-sued", 1, 2),
    ("outage-ost", "Freischaltung Leitung Ost", "line-ost", 3, 4),
    ("outage-west", "Freischaltung Leitung West", "line-west", 5, 6),
    ("outage-suedost", "Freischaltung Leitung Süd-Ost", "line-suedost", 0, 1),
    ("outage-trafo-sued", "Freischaltung Trafo Süd", "trafo-sued", 3, 4),
]
SCENARIOS = [
    ("Freischaltung Leitung Nord", ["outage-line"]),
    ("Freischaltung Trafo Nord", ["outage-trafo"]),
    ("Freischaltung Nord gesamt", ["outage-line", "outage-trafo"]),
    ("Freischaltung Leitung Süd", ["outage-sued"]),
    ("Freischaltung Leitung Ost", ["outage-ost"]),
    ("Freischaltung West und Süd-Ost", ["outage-west", "outage-suedost"]),
    ("Freischaltung Trafo Süd", ["outage-trafo-sued"]),
    ("Freischaltung Leitung Süd-Ost", ["outage-suedost"]),
]
# LODF[switched-off element][monitored line]: share of the lost flow taken over.
LODF = {
    "line-nord": {"line-ost": 0.10, "line-west": 0.30, "line-nordost": 0.55, "line-suedwest": 0.22, "line-ring": 0.05},
    "trafo-nord": {"line-suedwest": 0.06, "line-suedost": 0.35, "line-ring": 0.04, "line-sued": 0.10, "trafo-sued": 0.15},
    "line-sued": {"line-suedwest": 0.30, "line-ost": 0.25, "line-nord": 0.20, "line-ring": 0.06, "line-suedost": 0.10, "line-west": 0.15, "trafo-sued": 0.12},
    "line-ost": {"line-sued": 0.30, "line-suedwest": 0.15, "line-west": 0.20, "line-suedost": 0.30, "line-ring": 0.03},
    "line-west": {"line-sued": 0.35, "line-suedwest": 0.10, "line-nord": 0.20, "line-ost": 0.30, "line-nordost": 0.15},
    "line-suedost": {"line-nordost": 0.20, "line-suedwest": 0.12, "line-sued": 0.10},
    "trafo-sued": {"line-sued": 0.30, "line-suedost": 0.28, "line-suedwest": 0.22, "trafo-nord": 0.12, "line-ring": 0.05, "line-ost": 0.08},
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
                    "Diese Datei enthält andere Ergebnisse. Für Dummy-QDS eine eigene Datenbank verwenden: "
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
            "project": "Dummy QDS · synthetische Testdaten",
            "project_path": "Dummy.IntPrj",
            "study_case": "7 Tage · 15 Minuten",
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
                                    timestamp.isoformat(),
                                    round(values[metric[0]], 6),
                                    "ok",
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db", type=Path, default=ROOT / "backend/data/outage-assessment-demo.sqlite3"
    )
    print(create_dummy_database(parser.parse_args().db))
