"""One filtered population drives statistics, charts, ranking and export."""

from collections import defaultdict
from datetime import datetime, timezone
import math
from statistics import fmean, pstdev
from app.core.errors import InvalidRequestError, ResourceNotFoundError


def percentile(values, probability):
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lo = math.floor(position)
    hi = math.ceil(position)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (position - lo)


def exceeds(value, metric):
    return (metric["lower"] is not None and value < metric["lower"]) or (
        metric["upper"] is not None and value > metric["upper"]
    )


def summarize(rows, metric):
    values = [
        r["value"] for r in rows if r["value"] is not None and r["status"] != "failed"
    ]
    return {
        "count": len(values),
        "missing": len(rows) - len(values),
        "mean": fmean(values) if values else None,
        "min": min(values) if values else None,
        "max": max(values) if values else None,
        "std_dev": pstdev(values) if values else None,
        "p95": percentile(values, 0.95),
        "violations": sum(exceeds(v, metric) for v in values),
    }


def normalize_window(start, end):
    def utc(value):
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise InvalidRequestError(
                "Zeitstempel benötigen eine Zeitzone, z. B. +00:00."
            )
        return value.astimezone(timezone.utc)

    start, end = utc(start), utc(end)
    if start and end and start > end:
        raise InvalidRequestError("Der Beginn muss vor dem Ende liegen.")
    return start, end


def analyze(
    repo,
    run_id,
    metric_id="loading",
    compare_run_id=None,
    element_type=None,
    search=None,
    element_ids=None,
    start=None,
    end=None,
):
    start, end = normalize_window(start, end)
    run = repo.run(run_id)
    metric = next((m for m in repo.metrics(run_id) if m["id"] == metric_id), None)
    if metric is None:
        raise ResourceNotFoundError("Messgröße nicht vorhanden.")
    all_elements = repo.elements(run_id)
    if element_ids and set(element_ids) - {e["id"] for e in all_elements}:
        raise InvalidRequestError("Unbekannte Element-ID in der Auswahl.")
    elements = [
        e
        for e in all_elements
        if (not element_type or e["type"] == element_type)
        and (not element_ids or e["id"] in element_ids)
        and (not search or search.casefold() in (e["name"] + " " + e["id"]).casefold())
    ]
    ids = [e["id"] for e in elements]
    rows = repo.samples(run_id, metric_id, ids, start, end)
    valid = [r for r in rows if r["value"] is not None and r["status"] != "failed"]
    by_time = defaultdict(list)
    by_element = defaultdict(list)
    for row in rows:
        by_element[row["element_id"]].append(row)
        by_time[row["timestamp"]]
    for row in valid:
        by_time[row["timestamp"]].append(row["value"])
    points = [
        {
            "timestamp": ts,
            "mean": fmean(values) if values else None,
            "min": min(values) if values else None,
            "max": max(values) if values else None,
            "count": len(values),
        }
        for ts, values in sorted(by_time.items())
    ]
    # Refuse chart overload; never silently sample a raw result.
    if len(points) > 10000:
        raise InvalidRequestError(
            "Mehr als 10.000 Zeitpunkte. Bitte Zeitraum eingrenzen."
        )
    stats = summarize(rows, metric)
    ranking = [{**e, **summarize(by_element[e["id"]], metric)} for e in elements]
    ranking.sort(
        key=lambda e: (-(e["max"] if e["max"] is not None else -math.inf), e["id"])
    )
    values = sorted([r["value"] for r in valid], reverse=True)
    histogram = []
    if values:
        lo, hi = min(values), max(values)
        width = (hi - lo) / 12 if hi > lo else 1
        buckets = [0] * 12
        for value in values:
            buckets[min(11, int((value - lo) / width))] += 1
        histogram = [
            {"lower": lo + i * width, "upper": lo + (i + 1) * width, "count": count}
            for i, count in enumerate(buckets)
        ]
    # Duration curve is an explicitly labeled empirical quantile representation.
    duration = (
        [{"percent": i, "value": percentile(values, 1 - i / 100)} for i in range(101)]
        if values
        else []
    )
    comparison = None
    if compare_run_id:
        other = repo.run(compare_run_id)
        if other["project"] != run["project"]:
            raise InvalidRequestError(
                "Vergleich erfordert dasselbe Projekt und stabile Element-IDs."
            )
        other_metric = next(
            (m for m in repo.metrics(compare_run_id) if m["id"] == metric_id), None
        )
        if not other_metric or other_metric["unit"] != metric["unit"]:
            raise InvalidRequestError(
                "Messgröße oder Einheit der Vergleichs-Runs stimmt nicht überein."
            )
        other_rows = repo.samples(compare_run_id, metric_id, ids, start, end)
        other_by_key = {
            (r["element_id"], r["timestamp"]): r
            for r in other_rows
            if r["value"] is not None and r["status"] != "failed"
        }
        pairs = [
            (r, other_by_key[(r["element_id"], r["timestamp"])])
            for r in valid
            if (r["element_id"], r["timestamp"]) in other_by_key
        ]
        comparison_times = defaultdict(list)
        for _, r in pairs:
            comparison_times[r["timestamp"]].append(r["value"])
        comparison = {
            "run": other,
            "matched_count": len(pairs),
            "mean_delta": fmean(a["value"] - b["value"] for a, b in pairs)
            if pairs
            else None,
            "points": [
                {"timestamp": ts, "mean": fmean(v)}
                for ts, v in sorted(comparison_times.items())
            ],
        }
    return {
        "run": run,
        "metric": metric,
        "stats": stats,
        "points": points,
        "elements": ranking,
        "histogram": histogram,
        "duration": duration,
        "comparison": comparison,
        "meta": {
            "source": run["source"],
            "sample_count": len(rows),
            "element_count": len(elements),
            "timezone": "UTC",
            "series_aggregation": "mean_across_elements_per_timestamp",
            "duration_resolution": "101 empirical quantiles",
            "threshold_basis": "strictly outside metric bounds",
            "start": start.isoformat() if start else run["start"],
            "end": end.isoformat() if end else run["end"],
        },
    }, rows
