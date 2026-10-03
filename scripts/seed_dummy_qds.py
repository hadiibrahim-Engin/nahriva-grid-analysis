"""Small, persistent and explicitly synthetic QDS result database for Mac testing."""

import argparse
from datetime import datetime, timedelta, timezone
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.simulation.store import ScenarioStore, catalog_signature

START = datetime(2026, 1, 31, tzinfo=timezone.utc)
STEPS = 672  # 7 complete days at 15-minute steps, outside today's date window
ELEMENTS = [
    ("line-nord", "Leitung Nord–West", "ElmLne", "line", "Dummy/Leitung Nord"),
    ("line-sued", "Leitung Mitte–Süd", "ElmLne", "line", "Dummy/Leitung Süd"),
    ("trafo-nord", "Trafo Nord T1", "ElmTr2", "transformer", "Dummy/Trafo Nord"),
    ("bus-nord", "Sammelschiene Nord", "ElmTerm", "bus", "Dummy/Bus Nord"),
    ("bus-sued", "Sammelschiene Süd", "ElmTerm", "bus", "Dummy/Bus Süd"),
]
METRICS = [
    ("loading", "Auslastung", "%", None, 100),
    ("voltage", "Spannung", "p.u.", 0.95, 1.05),
    ("active_power", "Wirkleistung", "MW", None, None),
    ("reactive_power", "Blindleistung", "Mvar", None, None),
    ("current", "Strom", "A", None, None),
]


def create_dummy_database(path):
    path = Path(path).expanduser().resolve()
    store = ScenarioStore(str(path))
    try:
        catalog = store.catalog()
        has_data = store.db.execute("SELECT 1 FROM analysis_runs LIMIT 1").fetchone()
        if has_data:
            if not catalog or catalog.get("dummy_qds_version") != 1:
                raise ValueError(
                    "Diese Datei enthält andere Ergebnisse. Für Dummy-QDS eine eigene Datenbank verwenden: "
                    + str(path)
                )
            return path
        end = START + timedelta(minutes=15 * (STEPS - 1))
        outages = [
            {
                "id": "outage-line",
                "name": "Freischaltung Leitung Nord",
                "path": "Dummy/Leitung Nord.IntPlannedout",
                "equipment_name": "Leitung Nord–West",
                "start": int((START + timedelta(days=2)).timestamp()),
                "end": int((START + timedelta(days=3)).timestamp()),
                "ignored": False,
                "in_period": True,
            },
            {
                "id": "outage-trafo",
                "name": "Freischaltung Trafo Nord",
                "path": "Dummy/Trafo Nord.IntPlannedout",
                "equipment_name": "Trafo Nord T1",
                "start": int((START + timedelta(days=4)).timestamp()),
                "end": int((START + timedelta(days=5)).timestamp()),
                "ignored": False,
                "in_period": True,
            },
        ]
        catalog = {
            "project": "Dummy QDS · synthetische Testdaten",
            "project_path": "Dummy.IntPrj",
            "study_case": "7 Tage · 15 Minuten",
            "study_case_path": "Dummy.IntCase",
            "period": [int(START.timestamp()), int(end.timestamp())],
            "outages": outages,
            "dummy_qds_version": 1,
        }
        store.publish_catalog(catalog)
        for name, ids in [
            ("Freischaltung Leitung Nord", ["outage-line"]),
            ("Freischaltung Trafo Nord", ["outage-trafo"]),
            ("Freischaltung Nord gesamt", ["outage-line", "outage-trafo"]),
        ]:
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
                    hour = (step % 96) / 4
                    daily = (math.sin((hour - 8) / 24 * 2 * math.pi) + 1) / 2
                    active = (
                        sum(
                            o["id"] in ids
                            and o["start"] <= timestamp.timestamp() < o["end"]
                            for o in outages
                        )
                        if kind == "OUTAGE"
                        else 0
                    )
                    for i, element in enumerate(ELEMENTS):
                        loading = 35 + 7 * i + 38 * daily + active * (15 + 5 * i)
                        values = {
                            "loading": loading,
                            "voltage": 1.02 - daily * 0.025 - active * 0.025 * (i - 1),
                            "active_power": loading * 0.32,
                            "reactive_power": loading * 0.08,
                            "current": loading * 3.2,
                        }
                        for metric in METRICS:
                            if (element[3] == "bus") != (metric[0] == "voltage"):
                                continue
                            samples.append(
                                (
                                    element[0],
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
                            (e[0], "voltage", 0.95, 1.05)
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
