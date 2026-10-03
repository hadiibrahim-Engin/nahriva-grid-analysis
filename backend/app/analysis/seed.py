"""Deterministic illustrative measurements, explicitly never presented as a PF calculation."""

import math
from datetime import datetime, timedelta, timezone
from app.analysis.models import Element, Metric, Run, RunBundle, Sample

METRICS = [
    Metric(id="loading", name="Auslastung", unit="%", upper=100),
    Metric(id="voltage", name="Spannung", unit="p.u.", lower=0.9, upper=1.1),
    Metric(id="p", name="Wirkleistung P", unit="MW"),
    Metric(id="q", name="Blindleistung Q", unit="Mvar"),
    Metric(id="current", name="Strom", unit="A"),
    Metric(id="losses", name="Verluste", unit="MW", lower=0),
]


def demo_bundles():
    names = [
        "Leitung Nord – West",
        "Leitung West – Mitte",
        "Leitung Mitte – Süd",
        "Leitung Süd – Ost",
        "Trafo Nord T1",
        "Trafo Mitte T2",
        "Sammelschiene Nord",
        "Sammelschiene Süd",
    ]
    elements = [
        Element(
            id=f"elm-{i + 1:03}",
            name=name,
            className="ElmLne" if i < 4 else "ElmTr2" if i < 6 else "ElmTerm",
            type="line" if i < 4 else "transformer" if i < 6 else "terminal",
            path=f"Demo-Netz/Netzmodell/{name}",
        )
        for i, name in enumerate(names)
    ]
    for scenario in (0, 1):
        samples = []
        for step in range(192):
            timestamp = datetime(2026, 9, 21, tzinfo=timezone.utc) + timedelta(
                minutes=15 * step
            )
            hour = step % 96 / 4
            daily = (math.sin((hour - 8) / 24 * 2 * math.pi) + 1) / 2
            for i, element in enumerate(elements):
                loading = (
                    35
                    + i * 4
                    + daily * 34
                    + scenario * (10 + 8 * (i == 1))
                    + 4 * math.sin(step * 0.16 + i)
                )
                values = {
                    "loading": loading,
                    "voltage": 1.025 - loading * 0.00065 - scenario * 0.009 * (i == 7),
                    "p": (loading / 100) * (24 + i * 5),
                    "q": (loading / 100) * (6 + i),
                    "current": loading * (2.2 + i * 0.25),
                    "losses": (loading / 100) ** 2 * (0.12 + i * 0.03),
                }
                for metric in METRICS:
                    if element.type == "terminal" and metric.id not in ("voltage",):
                        continue
                    if element.type != "terminal" and metric.id == "voltage":
                        continue
                    value = round(values[metric.id], 5)
                    if step == 37 and i == 2 and metric.id == "loading":
                        value = None
                    samples.append(
                        Sample(
                            timestamp=timestamp,
                            element_id=element.id,
                            metric_id=metric.id,
                            value=value,
                        )
                    )
        yield RunBundle(
            run=Run(
                id="demo-reference" if not scenario else "demo-stress",
                name="Referenz · Normallast"
                if not scenario
                else "Variante · Erhöhte Last",
                project="Demo-Netz 110 kV",
                study_case="Lastfluss · Referenz"
                if not scenario
                else "Lastfluss · Lastvariante",
                source="demo",
            ),
            elements=elements,
            metrics=METRICS,
            samples=samples,
        )
