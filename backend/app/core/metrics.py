"""Lightweight in-process request metrics for the System Analytics view.

Design goals:
- **Cheap under load.** Recording a request is a single lock + append to a
  bounded deque (O(1)); no per-request allocation beyond one small tuple.
- **System-wide, not per-user.** Aggregates across all requests/users.
- **Privacy-safe.** Stores endpoint *templates* (e.g.
  ``/api/timeseries/raw/{component_id}/{measurement_type}``) and numbers —
  never concrete IDs, query strings, tokens, or SQL.

For multi-worker / multi-instance deployments this is per-process; export to
Prometheus (see docs) for a global view. This collector powers the in-app
dashboard, which is intentionally a "this instance, recent window" picture.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Any, Optional

# Rolling window of recent requests used for percentiles + time buckets.
_MAX_SAMPLES = 5_000

# One sample = (ts, endpoint, method, status, duration_ms, db_ms, mode, size).
_Sample = tuple


def _percentile(sorted_vals: list[float], pct: float) -> float:
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return round(sorted_vals[0], 1)
    k = (len(sorted_vals) - 1) * pct
    lo = int(k)
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = k - lo
    return round(sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac, 1)


class MetricsCollector:
    def __init__(self, max_samples: int = _MAX_SAMPLES) -> None:
        self._lock = threading.Lock()
        self._samples: deque[_Sample] = deque(maxlen=max_samples)
        self._total = 0
        self._timeouts = 0
        self._start = time.time()

    def record(
        self,
        *,
        endpoint: str,
        method: str,
        status: int,
        duration_ms: float,
        db_ms: float,
        mode: str,
        size: int,
    ) -> None:
        with self._lock:
            self._samples.append(
                (time.time(), endpoint, method, status, duration_ms, db_ms, mode, size)
            )
            self._total += 1
            if status == 504:
                self._timeouts += 1

    def reset(self) -> None:
        with self._lock:
            self._samples.clear()
            self._total = 0
            self._timeouts = 0
            self._start = time.time()

    def summary(self, *, top_n: int = 10, buckets_minutes: int = 30) -> dict[str, Any]:
        with self._lock:
            samples = list(self._samples)
            total = self._total
            timeouts = self._timeouts
            uptime = time.time() - self._start

        n = len(samples)
        durations = sorted(s[4] for s in samples)
        db_times = sorted(s[5] for s in samples)
        errors = sum(1 for s in samples if s[3] >= 500)
        client_errors = sum(1 for s in samples if 400 <= s[3] < 500)

        # modes
        modes = {"raw": 0, "aggregated": 0, "export": 0, "other": 0}
        for s in samples:
            modes[s[6]] = modes.get(s[6], 0) + 1

        # per-endpoint rollup
        by_ep: dict[str, dict[str, Any]] = {}
        for ts, ep, _m, status, dur, db, _mode, _sz in samples:
            e = by_ep.setdefault(
                ep, {"endpoint": ep, "count": 0, "errors": 0, "_durs": [], "_db": 0.0}
            )
            e["count"] += 1
            e["_db"] += db
            e["_durs"].append(dur)
            if status >= 500:
                e["errors"] += 1
        endpoints = []
        for e in by_ep.values():
            durs = sorted(e["_durs"])
            endpoints.append(
                {
                    "endpoint": e["endpoint"],
                    "count": e["count"],
                    "error_rate": round(e["errors"] / e["count"], 4) if e["count"] else 0,
                    "p50_ms": _percentile(durs, 0.50),
                    "p95_ms": _percentile(durs, 0.95),
                    "avg_db_ms": round(e["_db"] / e["count"], 1) if e["count"] else 0,
                }
            )
        endpoints.sort(key=lambda x: x["count"], reverse=True)
        slowest = sorted(endpoints, key=lambda x: x["p95_ms"], reverse=True)[:top_n]

        # requests over time (per-minute buckets, most recent `buckets_minutes`)
        now = time.time()
        per_min: dict[int, int] = {}
        for s in samples:
            bucket = int((now - s[0]) // 60)
            if bucket < buckets_minutes:
                per_min[bucket] = per_min.get(bucket, 0) + 1
        over_time = [
            {"minutes_ago": b, "count": per_min.get(b, 0)}
            for b in range(buckets_minutes - 1, -1, -1)
        ]

        return {
            "window_sample_count": n,
            "total_requests": total,
            "uptime_seconds": round(uptime, 1),
            "latency_ms": {
                "p50": _percentile(durations, 0.50),
                "p95": _percentile(durations, 0.95),
                "p99": _percentile(durations, 0.99),
            },
            "db_ms": {
                "p50": _percentile(db_times, 0.50),
                "p95": _percentile(db_times, 0.95),
                "p99": _percentile(db_times, 0.99),
            },
            "error_rate": round(errors / n, 4) if n else 0,
            "status_classes": {
                "server_errors_5xx": errors,
                "client_errors_4xx": client_errors,
                "ok": n - errors - client_errors,
            },
            "timeouts": timeouts,
            "measurement_modes": modes,
            "top_endpoints": endpoints[:top_n],
            "slowest_endpoints": slowest,
            "requests_over_time": over_time,
            "cache": _cache_stats(),
            "db_pool": _pool_stats(),
        }


def _cache_stats() -> dict[str, Any]:
    try:
        from app.core.cache import analytics_cache

        hits, misses = analytics_cache.hits, analytics_cache.misses
        total = hits + misses
        return {
            "hits": hits,
            "misses": misses,
            "hit_rate": round(hits / total, 4) if total else 0,
        }
    except Exception:
        return {"hits": 0, "misses": 0, "hit_rate": 0}


def _pool_stats() -> Optional[dict[str, Any]]:
    """DB pool gauges. Returns None if the engine isn't initialised."""
    try:
        from app.db.database import get_engine

        pool = get_engine().pool
        return {
            "size": pool.size(),
            "checked_in": pool.checkedin(),
            "checked_out": pool.checkedout(),
            "overflow": pool.overflow(),
        }
    except Exception:
        return None


# Module-level singleton shared by middleware + the admin endpoint.
metrics_collector = MetricsCollector()


def classify_mode(path: str) -> str:
    if "/timeseries/raw/" in path:
        return "raw"
    if "/timeseries/aggregate/" in path:
        return "aggregated"
    if "/export/" in path:
        return "export"
    return "other"
