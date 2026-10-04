"""Serve the original DashB chart contracts from simulation samples only."""

import base64
import json
import math
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from statistics import fmean, pstdev, median
from app.core.errors import (
    InvalidRequestError,
    ResourceNotFoundError,
    RawRangeTooLargeError,
)

METRIC_CODES = {
    "loading": "L",
    "voltage": "U",
    "active_power": "P",
    "reactive_power": "Q",
    "apparent_power": "S",
    "current": "I",
    "losses": "LOSS",
}


def percentile(values, probability):
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lo = math.floor(position)
    hi = math.ceil(position)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (position - lo)


def component_id(run_id, element_id):
    return (
        base64.urlsafe_b64encode(json.dumps([run_id, element_id]).encode())
        .decode()
        .rstrip("=")
    )


def resolve(repo, identifier):
    try:
        run_id, element_id = json.loads(
            base64.urlsafe_b64decode(identifier + "=" * (-len(identifier) % 4))
        )
        if not isinstance(run_id, str) or not isinstance(element_id, str):
            raise ValueError()
    except (ValueError, TypeError, UnicodeError):
        raise InvalidRequestError(
            "Invalid scenario or equipment identifier."
        ) from None
    element = next((e for e in repo.elements(run_id) if e["id"] == element_id), None)
    if element is None:
        raise ResourceNotFoundError("Equipment not found in the scenario.")
    return run_id, element


def parse_time(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise InvalidRequestError("Invalid timestamp.") from None
    return (
        parsed.replace(tzinfo=timezone.utc)
        if parsed.tzinfo is None
        else parsed.astimezone(timezone.utc)
    )


def dataset(repo, identifier, code, start=None, end=None):
    run_id, element = resolve(repo, identifier)
    metric = next(
        (m for m in repo.metrics(run_id) if METRIC_CODES.get(m["id"], m["id"]) == code),
        None,
    )
    if metric is None:
        raise ResourceNotFoundError(
            "This measurement is not stored in the scenario."
        )
    begin = parse_time(start) if start else None
    finish = parse_time(end) if end else None
    if begin and finish and begin > finish:
        raise InvalidRequestError("The start must be before the end.")
    conditions = ["se.run_id=?", "se.metric_id=?", "se.element_id=?"]
    params = [run_id, metric["id"], element["id"]]
    if begin:
        conditions.append("v.t >= ?")
        params.append(begin.timestamp())
    if finish:
        conditions.append("v.t <= ?")
        params.append(finish.timestamp())
    stored = repo._all(
        "SELECT v.t, v.value FROM analysis_series se JOIN analysis_values v ON v.series_id = se.id WHERE "
        + " AND ".join(conditions)
        + " ORDER BY v.t LIMIT 200001",
        params,
    )
    if len(stored) > 200000:
        raise RawRangeTooLargeError(estimated_points=len(stored), max_points=200000)
    rows = [
        {"timestamp": datetime.fromtimestamp(r["t"], timezone.utc).isoformat(), "value": r["value"]}
        for r in stored
    ]
    points = [row for row in rows if row["value"] is not None]
    base = {
        "component_id": identifier,
        "component_name": element["name"],
        "measurement_type": code,
        "unit": metric["unit"],
    }
    return base, points, rows


def native_step(rows):
    gaps = [
        (parse_time(b["timestamp"]) - parse_time(a["timestamp"])).total_seconds()
        for a, b in zip(rows, rows[1:])
    ]
    return min((gap for gap in gaps if gap > 0), default=0)


def timeseries(
    repo,
    identifier,
    code,
    start,
    end,
    bucket=None,
    method="AVG",
    limit=50000,
    cursor=None,
):
    base, points, rows = dataset(repo, identifier, code, start, end)
    step = native_step(rows)
    if bucket is not None:
        if bucket <= 0 or method not in ("AVG", "MIN", "MAX", "SUM"):
            raise InvalidRequestError(
                "Invalid aggregation interval or method."
            )
        groups = defaultdict(list)
        for point in points:
            groups[
                int(parse_time(point["timestamp"]).timestamp()) // bucket * bucket
            ].append(point["value"])
        aggregate = {"AVG": fmean, "MIN": min, "MAX": max, "SUM": sum}[method]
        points = [
            {
                "timestamp": datetime.fromtimestamp(t, timezone.utc).isoformat(),
                "value": aggregate(values),
            }
            for t, values in sorted(groups.items())
        ]
    next_cursor = None
    if bucket is None:
        if cursor:
            cursor_time = parse_time(cursor)
            points = [p for p in points if parse_time(p["timestamp"]) > cursor_time]
        if len(points) > limit:
            next_cursor = points[limit - 1]["timestamp"]
            points = points[:limit]
    return {
        **base,
        "data": points,
        "next_cursor": next_cursor,
        "meta": {
            "is_raw": bucket is None,
            "downsampled": bucket is not None,
            "aggregation_method": method if bucket else None,
            "bucket_seconds": bucket,
            "native_resolution_seconds": step,
            "point_count": len(points),
            "source": "simulation",
            "start": start,
            "end": end,
            "request_id": None,
        },
    }


def metric_analytics(
    repo, identifier, code, kind, start=None, end=None, group_by="hour", threshold=100
):
    base, points, rows = dataset(repo, identifier, code, start, end)
    values = [p["value"] for p in points]
    if kind == "duration-curve":
        return {
            **base,
            "data": [
                {"percent": p, "value": percentile(values, 1 - p / 100)}
                for p in range(101)
            ]
            if values
            else [],
        }
    if kind == "boxplot":
        if group_by not in ("hour", "weekday", "month", "weekday_weekend"):
            raise InvalidRequestError("Invalid boxplot grouping.")
        groups = defaultdict(list)
        for point in points:
            time = parse_time(point["timestamp"])
            key = {
                "hour": time.hour,
                "weekday": time.weekday(),
                "month": time.month,
                "weekday_weekend": int(time.weekday() >= 5),
            }[group_by]
            groups[key].append(point["value"])
        return {
            **base,
            "group_by": group_by,
            "items": [
                {
                    "label": ("Weekend" if key else "Weekday")
                    if group_by == "weekday_weekend"
                    else str(key),
                    "min": min(v),
                    "q1": percentile(v, 0.25),
                    "median": median(v),
                    "q3": percentile(v, 0.75),
                    "max": max(v),
                }
                for key, v in sorted(groups.items())
            ],
        }
    if kind == "exceedance":
        step = native_step(rows)
        days = defaultdict(list)
        total = duration = 0
        for row, following in zip(rows, rows[1:]):
            span = (
                parse_time(following["timestamp"]) - parse_time(row["timestamp"])
            ).total_seconds()
            if span > step * 1.5 or row["value"] is None:
                continue
            duration += span
            if row["value"] > threshold:
                total += span
                days[row["timestamp"][:10]].append((span / 60, row["value"]))
        return {
            **base,
            "threshold": threshold,
            "total_minutes_above": total / 60,
            "total_pct": total / duration * 100 if duration else 0,
            "top_days": sorted(
                [
                    {
                        "day": d,
                        "minutes_above": sum(t for t, _ in v),
                        "max_value": max(x for _, x in v),
                        "mean_value": fmean(x for _, x in v),
                    }
                    for d, v in days.items()
                ],
                key=lambda row: -row["minutes_above"],
            )[:10],
        }
    raise ResourceNotFoundError("Chart type not supported.")


def pearson(left, right):
    if len(left) < 2:
        return None
    a, b = fmean(left), fmean(right)
    denominator = math.sqrt(
        sum((v - a) ** 2 for v in left) * sum((v - b) ** 2 for v in right)
    )
    return (
        sum((x - a) * (y - b) for x, y in zip(left, right)) / denominator
        if denominator
        else None
    )


def component_analytics(
    repo,
    identifier,
    kind,
    start=None,
    end=None,
    types=None,
):
    run_id, element = resolve(repo, identifier)
    available = repo._all(
        "SELECT m.id,m.unit FROM analysis_metrics m JOIN analysis_series se ON se.run_id=m.run_id AND se.metric_id=m.id WHERE m.run_id=? AND se.element_id=?",
        (run_id, element["id"]),
    )
    codes = {METRIC_CODES.get(m["id"], m["id"]): m["unit"] for m in available}

    def series(code):
        return dataset(repo, identifier, code, start, end)[1] if code in codes else []

    base = {"component_name": element["name"]}
    if kind == "correlation-matrix":
        selected = types.split(",") if types else ["P", "Q"]
        if any(code not in codes for code in selected):
            raise ResourceNotFoundError(
                "The required measurements are not in the results."
            )
        lookup = {
            code: {p["timestamp"]: p["value"] for p in series(code)}
            for code in selected
        }
        matrix = []
        for a in selected:
            row = []
            for b in selected:
                keys = sorted(lookup[a].keys() & lookup[b].keys())
                row.append(pearson([lookup[a][k] for k in keys], [lookup[b][k] for k in keys]))
            matrix.append(row)
        return {
            **base,
            "types": selected,
            "units": [codes[c] for c in selected],
            "matrix": matrix,
        }
    raise ResourceNotFoundError("Chart type not supported.")
