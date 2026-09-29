"""Per-IP sliding-window rate limit for the login endpoint.

Login bypasses the SQLAlchemy pool and opens a fresh Oracle session per
attempt, so unbounded login traffic can exhaust Oracle's SESSIONS or
PROCESSES regardless of how the dashboard is sized. This limiter caps
attempts per IP without adding a runtime dependency.

Limitations:
- In-process state. With multiple uvicorn workers each worker keeps its
  own counter, so the effective limit per IP is N_workers x configured.
- Behind a reverse proxy, request.client.host is the proxy IP. Configure
  the proxy to forward the real client (X-Forwarded-For / X-Real-IP) and
  enable Starlette's ProxyHeadersMiddleware in app/main.py if you need
  true per-client limiting.
- For multi-instance deployments, swap this for a Redis-backed limiter.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Deque

from fastapi import HTTPException, Request, status

from app.core.constants import (
    API_RATE_LIMIT_REQUESTS,
    API_RATE_LIMIT_WINDOW_SECONDS,
    LOGIN_RATE_LIMIT_ATTEMPTS,
    LOGIN_RATE_LIMIT_WINDOW_SECONDS,
)

_MAX_TRACKED_IPS = 10_000


class _SlidingWindowLimiter:
    """Per-key sliding-window counter shared across requests."""

    def __init__(self) -> None:
        self._entries: dict[str, Deque[float]] = {}
        self._lock = threading.Lock()

    def check(self, key: str, limit: int, window_seconds: int, error_message: str) -> None:
        now = time.monotonic()
        with self._lock:
            if len(self._entries) > _MAX_TRACKED_IPS:
                stale = [
                    k for k, q in self._entries.items()
                    if not q or now - q[-1] > window_seconds
                ]
                for k in stale:
                    self._entries.pop(k, None)

            queue = self._entries.setdefault(key, deque())
            while queue and now - queue[0] > window_seconds:
                queue.popleft()

            if len(queue) >= limit:
                retry_after = int(window_seconds - (now - queue[0])) + 1
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail=error_message,
                    headers={"Retry-After": str(retry_after)},
                )

            queue.append(now)


_login_limiter = _SlidingWindowLimiter()
_api_limiter = _SlidingWindowLimiter()


def _client_ip(request: Request) -> str:
    """Best-effort client IP. Trusts proxy headers only if explicitly forwarded."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    if request.client is not None:
        return request.client.host
    return "unknown"


def login_rate_limit(request: Request) -> None:
    """FastAPI dependency. Raises 429 if the source IP exceeded the window."""
    _login_limiter.check(
        _client_ip(request),
        LOGIN_RATE_LIMIT_ATTEMPTS,
        LOGIN_RATE_LIMIT_WINDOW_SECONDS,
        "Zu viele Anmeldeversuche. Bitte warten.",
    )


def api_rate_limit(request: Request) -> None:
    """Per-IP cap on every /api/* request. Used by ApiRateLimitMiddleware."""
    _api_limiter.check(
        _client_ip(request),
        API_RATE_LIMIT_REQUESTS,
        API_RATE_LIMIT_WINDOW_SECONDS,
        "Zu viele Anfragen. Bitte warten.",
    )
