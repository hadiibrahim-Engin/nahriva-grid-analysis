"""Serve the original DashB chart contracts from simulation samples only."""

import base64
import json
import math
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from statistics import fmean, pstdev, median
from app.analysis.service import percentile
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
            "Ungültige Szenario-/Betriebsmittelkennung."
        ) from None
    element = next((e for e in repo.elements(run_id) if e["id"] == element_id), None)
    if element is None:
        raise ResourceNotFoundError("Betriebsmittel im Szenario nicht gefunden.")
    return run_id, element


def parse_time(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise InvalidRequestError("Ungültiger Zeitstempel.") from None
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
            "Diese Messgröße ist im Szenario nicht gespeichert."
        )
    begin = parse_time(start) if start else None
    finish = parse_time(end) if end else None
    if begin and finish and begin > finish:
        raise InvalidRequestError("Der Beginn muss vor dem Ende liegen.")
    conditions = ["run_id=?", "element_id=?", "metric_id=?"]
    params = [run_id, element["id"], metric["id"]]
    if begin:
        conditions.append("timestamp >= ?")
        params.append(begin.isoformat())
    if finish:
        conditions.append("timestamp <= ?")
        params.append(finish.isoformat())
    rows = repo._all(
        "SELECT timestamp,value,status FROM analysis_samples WHERE "
        + " AND ".join(conditions)
        + " ORDER BY timestamp LIMIT 200001",
        params,
    )
    if len(rows) > 200000:
        raise RawRangeTooLargeError(estimated_points=len(rows), max_points=200000)
    points = [
        {"timestamp": r["timestamp"], "value": r["value"]}
        for r in rows
        if r["value"] is not None and r["status"] != "failed"
    ]
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
                "Ungültiges Aggregationsintervall oder Verfahren."
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
    if kind == "stats":
        return {
            **base,
            "count": len(values),
            "mean": fmean(values) if values else None,
            "min": min(values) if values else None,
            "max": max(values) if values else None,
            "std_dev": pstdev(values) if values else None,
        }
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
    if kind in ("heatmap", "daily-profile", "boxplot"):
        groups = defaultdict(list)
        if group_by not in ("hour", "weekday", "month", "weekday_weekend"):
            raise InvalidRequestError("Ungültige Boxplot-Gruppierung.")
        for point in points:
            time = parse_time(point["timestamp"])
            if kind == "heatmap":
                key = (time.weekday(), time.hour)
            elif kind == "daily-profile":
                key = (time.weekday() >= 5, time.hour)
            else:
                key = {
                    "hour": time.hour,
                    "weekday": time.weekday(),
                    "month": time.month,
                    "weekday_weekend": int(time.weekday() >= 5),
                }[group_by]
            groups[key].append(point["value"])
        if kind == "heatmap":
            return {
                **base,
                "data": [
                    {"day_of_week": key[0], "hour": key[1], "value": fmean(v)}
                    for key, v in sorted(groups.items())
                ],
            }
        if kind == "daily-profile":
            return {
                **base,
                **{
                    label: [
                        {"hour": hour, "value": fmean(v), "std_dev": pstdev(v)}
                        for (is_weekend, hour), v in sorted(groups.items())
                        if is_weekend == weekend
                    ]
                    for label, weekend in [
                        ("weekday_avg", False),
                        ("weekend_avg", True),
                    ]
                },
            }
        return {
            **base,
            "group_by": group_by,
            "items": [
                {
                    "label": ("Wochenende" if key else "Werktag")
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
            if span > step * 1.5 or row["value"] is None or row["status"] == "failed":
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
    raise ResourceNotFoundError("Diagrammtyp nicht unterstützt.")


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
    type_x="P",
    type_y="Q",
    lag_minutes=0,
):
    run_id, element = resolve(repo, identifier)
    available = repo._all(
        "SELECT DISTINCT m.id,m.unit FROM analysis_metrics m JOIN analysis_samples s ON s.run_id=m.run_id AND s.metric_id=m.id WHERE m.run_id=? AND s.element_id=?",
        (run_id, element["id"]),
    )
    codes = {METRIC_CODES.get(m["id"], m["id"]): m["unit"] for m in available}

    def series(code):
        return dataset(repo, identifier, code, start, end)[1] if code in codes else []

    base = {"component_name": element["name"]}
    if kind == "dst-events":
        # Simulation timestamps are UTC and have no DST gaps or duplicate hours.
        return {**base, "events": []}
    if kind == "voltage-band":
        groups = defaultdict(list)
        for p in series("U"):
            t = parse_time(p["timestamp"])
            groups[t.weekday() >= 5, t.hour].append(p["value"])
        return {
            **base,
            "unit": codes.get("U", ""),
            **{
                name: [
                    {
                        "timestamp": f"2000-01-03T{hour:02}:00:00+00:00",
                        "min": min(v),
                        "mean": fmean(v),
                        "max": max(v),
                    }
                    for (is_weekend, hour), v in sorted(groups.items())
                    if is_weekend == weekend
                ]
                for name, weekend in [("weekday", False), ("weekend", True)]
            },
        }
    if kind in ("correlation", "correlation-matrix"):
        selected = types.split(",") if types else [type_x, type_y]
        if any(code not in codes for code in selected):
            raise ResourceNotFoundError(
                "Benötigte Messgrößen sind im Ergebnis nicht vorhanden."
            )
        lookup = {
            code: {p["timestamp"]: p["value"] for p in series(code)}
            for code in selected
        }
        if kind == "correlation-matrix":
            matrix = []
            for a in selected:
                row = []
                for b in selected:
                    keys = sorted(lookup[a].keys() & lookup[b].keys())
                    row.append(
                        pearson(
                            [lookup[a][k] for k in keys], [lookup[b][k] for k in keys]
                        )
                    )
                matrix.append(row)
            return {
                **base,
                "types": selected,
                "units": [codes[c] for c in selected],
                "matrix": matrix,
            }
        shifted = {
            (parse_time(t) - timedelta(minutes=lag_minutes)).isoformat(): v
            for t, v in lookup[type_y].items()
        }
        keys = sorted(lookup[type_x].keys() & shifted.keys())
        xs = [lookup[type_x][k] for k in keys]
        ys = [shifted[k] for k in keys]
        return {
            **base,
            "type_x": type_x,
            "type_y": type_y,
            "unit_x": codes[type_x],
            "unit_y": codes[type_y],
            "correlation": pearson(xs, ys),
            "lag_minutes": lag_minutes,
            "interpretation": "Vergleich zeitlich identischer Simulationsergebnisse.",
            "data": [{"x": x, "y": y} for x, y in zip(xs, ys)],
        }
    if kind == "power-factor":
        p = {r["timestamp"]: r["value"] for r in series("P")}
        q = {r["timestamp"]: r["value"] for r in series("Q")}
        s = {r["timestamp"]: r["value"] for r in series("S")}
        data = []
        for t in sorted(p.keys() & q.keys()):
            apparent = s.get(t, math.hypot(p[t], q[t]))
            data.append(
                {
                    "timestamp": t,
                    "p": p[t],
                    "q": q[t],
                    "s": apparent,
                    "cos_phi": p[t] / apparent if apparent else None,
                    "tan_phi": q[t] / p[t] if p[t] else None,
                }
            )
        bins = [i / 20 for i in range(21)]
        counts = [0] * 20
        for r in data:
            if r["cos_phi"] is not None:
                counts[min(19, int(abs(r["cos_phi"]) * 20))] += 1
        return {
            **base,
            "data": data,
            "histogram_bins": bins,
            "histogram_counts": counts,
        }
    if kind == "season-radar":
        selected = types.split(",") if types else list(codes)
        output = []
        for code in selected:
            groups = defaultdict(list)
            for p in series(code):
                groups[parse_time(p["timestamp"]).month].append(p["value"])
            if any(not groups[m] for m in range(1, 13)):
                raise ResourceNotFoundError(
                    "Das Jahresprofil benötigt Simulationsergebnisse für alle zwölf Monate."
                )
            output.append(
                {
                    "measurement_type": code,
                    "unit": codes.get(code, ""),
                    "monthly_medians": [median(groups[m]) for m in range(1, 13)],
                }
            )
        return {
            **base,
            "months": [
                "Jan",
                "Feb",
                "Mär",
                "Apr",
                "Mai",
                "Jun",
                "Jul",
                "Aug",
                "Sep",
                "Okt",
                "Nov",
                "Dez",
            ],
            "series": output,
        }
    if kind == "quality":
        daily = []
        gaps = []
        for code in codes:
            _, _, rows = dataset(repo, identifier, code, start, end)
            step = native_step(rows)
            grouped = defaultdict(list)
            for r in rows:
                grouped[r["timestamp"][:10]].append(r)
            for day, items in sorted(grouped.items()):
                valid = [
                    r
                    for r in items
                    if r["value"] is not None and r["status"] != "failed"
                ]
                span = (
                    parse_time(items[-1]["timestamp"])
                    - parse_time(items[0]["timestamp"])
                ).total_seconds()
                expected = round(span / step) + 1 if step else len(items)
                daily.append(
                    {
                        "day": day,
                        "measurement_type": code,
                        "count": len(valid),
                        "expected": expected,
                        "missing_pct": max(0, 1 - len(valid) / expected) * 100
                        if expected
                        else 0,
                    }
                )
                hours = defaultdict(int)
                for r in valid:
                    hours[parse_time(r["timestamp"]).hour] += 1
                gaps.extend(
                    {"day": day, "hour": h, "measurement_type": code, "count": hours[h]}
                    for h in range(24)
                )
        return {
            **base,
            "measurement_types": list(codes),
            "daily_counts": daily,
            "gap_heatmap": gaps,
        }
    raise ResourceNotFoundError("Diagrammtyp nicht unterstützt.")
