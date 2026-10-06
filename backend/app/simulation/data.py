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
    return _sorted_percentile(sorted(values), probability)


def _sorted_percentile(ordered, probability):
    if not ordered:
        return None
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
    element = repo.element(run_id, element_id)
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


# A series is handled as two lists, epoch seconds and values: a year at 15 minutes is 35 040 points, and a
# datetime, an ISO string and a dict per point cost far more than the query. ISO strings are made only for what is sent.
def _iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def dataset(repo, identifier, code, start=None, end=None):
    """(description, epoch seconds, values) of one series; a value is None where PowerFactory had none."""
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
    stored = repo.tuples(
        "SELECT v.t, v.value FROM analysis_series se JOIN analysis_values v ON v.series_id = se.id WHERE "
        + " AND ".join(conditions)
        + " ORDER BY v.t LIMIT 200001",
        params,
    )
    if len(stored) > 200000:
        raise RawRangeTooLargeError(estimated_points=len(stored), max_points=200000)
    base = {
        "component_id": identifier,
        "component_name": element["name"],
        "measurement_type": code,
        "unit": metric["unit"],
    }
    return base, [row[0] for row in stored], [row[1] for row in stored]


def native_step(stamps):
    """The smallest positive gap between two consecutive times, in seconds (0 when there is none)."""
    gaps = [b - a for a, b in zip(stamps, stamps[1:]) if b > a]
    return float(min(gaps)) if gaps else 0


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
    base, stamps, values = dataset(repo, identifier, code, start, end)
    step = native_step(stamps)
    points = [(t, v) for t, v in zip(stamps, values) if v is not None]
    if bucket is not None:
        if bucket <= 0 or method not in ("AVG", "MIN", "MAX", "SUM"):
            raise InvalidRequestError(
                "Invalid aggregation interval or method."
            )
        groups = defaultdict(list)
        for t, v in points:
            groups[t // bucket * bucket].append(v)
        aggregate = {"AVG": fmean, "MIN": min, "MAX": max, "SUM": sum}[method]
        points = [(t, aggregate(group)) for t, group in sorted(groups.items())]
    next_cursor = None
    if bucket is None:
        if cursor:
            cursor_time = parse_time(cursor).timestamp()
            points = [p for p in points if p[0] > cursor_time]
        if len(points) > limit:
            next_cursor = _iso(points[limit - 1][0])
            points = points[:limit]
    return {
        **base,
        "data": [{"timestamp": _iso(t), "value": v} for t, v in points],
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


class _Calendar:
    """Weekday, month and date (UTC) of an epoch second, worked out once per day."""

    def __init__(self):
        self._days = {}

    def day(self, epoch):
        number = epoch // 86400
        found = self._days.get(number)
        if found is None:
            date = datetime.fromtimestamp(number * 86400, timezone.utc)
            found = self._days[number] = (date.weekday(), date.month, date.date().isoformat())
        return found


def metric_analytics(
    repo, identifier, code, kind, start=None, end=None, group_by="hour", threshold=100
):
    base, stamps, series = dataset(repo, identifier, code, start, end)
    values = [v for v in series if v is not None]
    if kind == "duration-curve":
        ordered = sorted(values)
        return {
            **base,
            "data": [
                {"percent": p, "value": _sorted_percentile(ordered, 1 - p / 100)}
                for p in range(101)
            ]
            if values
            else [],
        }
    if kind == "boxplot":
        if group_by not in ("hour", "weekday", "month", "weekday_weekend"):
            raise InvalidRequestError("Invalid boxplot grouping.")
        calendar = _Calendar()
        groups = defaultdict(list)
        for t, value in zip(stamps, series):
            if value is None:
                continue
            weekday, month, _date = calendar.day(t)
            key = {
                "hour": t // 3600 % 24,
                "weekday": weekday,
                "month": month,
                "weekday_weekend": int(weekday >= 5),
            }[group_by]
            groups[key].append(value)
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
        step = native_step(stamps)
        calendar = _Calendar()
        days = defaultdict(list)
        total = duration = 0
        for t, value, following in zip(stamps, series, stamps[1:]):
            span = float(following - t)
            if span > step * 1.5 or value is None:
                continue
            duration += span
            if value > threshold:
                total += span
                days[calendar.day(t)[2]].append((span / 60, value))
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
        """{epoch second: value} of the valid values of one measurement."""
        if code not in codes:
            return {}
        _base, stamps, values = dataset(repo, identifier, code, start, end)
        return {t: v for t, v in zip(stamps, values) if v is not None}

    base = {"component_name": element["name"]}
    if kind == "correlation-matrix":
        selected = types.split(",") if types else ["P", "Q"]
        if any(code not in codes for code in selected):
            raise ResourceNotFoundError(
                "The required measurements are not in the results."
            )
        lookup = {code: series(code) for code in selected}
        matrix = [[None] * len(selected) for _ in selected]
        for i, a in enumerate(selected):
            for j, b in enumerate(selected):
                if j < i:  # the coefficient is symmetric, to the last digit: the same products in the same order
                    matrix[i][j] = matrix[j][i]
                    continue
                keys = sorted(lookup[a].keys() & lookup[b].keys())
                matrix[i][j] = pearson([lookup[a][k] for k in keys], [lookup[b][k] for k in keys])
        return {
            **base,
            "types": selected,
            "units": [codes[c] for c in selected],
            "matrix": matrix,
        }
    raise ResourceNotFoundError("Chart type not supported.")
