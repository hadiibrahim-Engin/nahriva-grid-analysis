"""ASGI middleware: request ID tagging, access logging, security headers."""

from __future__ import annotations

import logging
import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.core.logging import db_time_ms_var, request_id_var
from app.core.metrics import classify_mode, metrics_collector

_log = logging.getLogger("app.access")

# Conservative defaults. Adjust CSP if you start serving third-party scripts,
# fonts, or analytics from non-self origins.
_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    # Strict-Transport-Security is only meaningful behind TLS; enable via
    # the reverse proxy or set ENABLE_HSTS=1 in the environment.
    # CSP keeps 'unsafe-inline' style so Tailwind JIT styles work in the
    # bundled output; tighten if you adopt CSP nonces.
    "Content-Security-Policy": (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; "
        "font-src 'self' data:; "
        "connect-src 'self'; "
        "frame-ancestors 'none'"
    ),
}


# HSTS is only safe over TLS, so it is opt-in. One year, includeSubDomains;
# add "; preload" manually only after submitting to the HSTS preload list.
_HSTS_HEADER = ("Strict-Transport-Security", "max-age=31536000; includeSubDomains")


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Attach a small fixed set of hardening headers to every response."""

    def __init__(self, app, enable_hsts: bool = False):
        super().__init__(app)
        self._headers = dict(_SECURITY_HEADERS)
        if enable_hsts:
            key, value = _HSTS_HEADER
            self._headers[key] = value

    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        headers = dict(self._headers)
        if request.url.path in ("/docs", "/redoc"):
            # Swagger/ReDoc bootstrap inline; vendored assets use self and the
            # optional CDN fallback uses jsDelivr. Application routes stay strict.
            headers["Content-Security-Policy"] = (
                "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
                "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
                "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
            )
        for key, value in headers.items():
            response.headers.setdefault(key, value)
        return response


class ApiRateLimitMiddleware(BaseHTTPMiddleware):
    """Per-IP request-rate cap on all /api/* paths except health probes."""

    _EXEMPT_PREFIXES = ("/api/health",)

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if path.startswith("/api/") and not any(path.startswith(p) for p in self._EXEMPT_PREFIXES):
            # Defer the import so unit tests for other middleware don't pull
            # in the rate-limit module unnecessarily.
            from app.auth.rate_limit import api_rate_limit
            from fastapi import HTTPException
            from fastapi.responses import JSONResponse
            try:
                api_rate_limit(request)
            except HTTPException as exc:
                return JSONResponse(
                    status_code=exc.status_code,
                    content={"detail": exc.detail},
                    headers=exc.headers or {},
                )
        return await call_next(request)


class RequestIdMiddleware(BaseHTTPMiddleware):
    """Assign a request ID, expose it as a header, log a structured access line."""

    async def dispatch(self, request: Request, call_next):
        incoming = request.headers.get("x-request-id")
        rid = incoming if incoming and len(incoming) <= 64 else uuid.uuid4().hex
        token = request_id_var.set(rid)
        db_token = db_time_ms_var.set(0.0)
        start = time.perf_counter()
        try:
            response: Response = await call_next(request)
        except Exception:
            _log.exception(
                "request failed",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "duration_ms": round((time.perf_counter() - start) * 1000, 1),
                    "db_ms": round(db_time_ms_var.get(), 1),
                },
            )
            raise
        else:
            total_ms = (time.perf_counter() - start) * 1000
            db_ms = db_time_ms_var.get()
            response.headers["X-Request-ID"] = rid
            # Server-Timing lets browsers and load tests separate Oracle
            # time from app/serialization time without extra tooling.
            response.headers["Server-Timing"] = (
                f"db;dur={db_ms:.1f}, app;dur={max(0.0, total_ms - db_ms):.1f}, "
                f"total;dur={total_ms:.1f}"
            )
            path = request.url.path
            _log.info(
                "request",
                extra={
                    "method": request.method,
                    "path": path,
                    "status": response.status_code,
                    "duration_ms": round(total_ms, 1),
                    "db_ms": round(db_ms, 1),
                },
            )
            if path.startswith("/api/") and not path.startswith("/api/health"):
                # Endpoint template (no IDs/query-strings) keeps metric
                # cardinality bounded and avoids leaking identifiers.
                route = request.scope.get("route")
                endpoint = getattr(route, "path", path)
                try:
                    size = int(response.headers.get("content-length") or 0)
                except (TypeError, ValueError):
                    size = 0
                metrics_collector.record(
                    endpoint=endpoint,
                    method=request.method,
                    status=response.status_code,
                    duration_ms=total_ms,
                    db_ms=db_ms,
                    mode=classify_mode(path),
                    size=size,
                )
            return response
        finally:
            request_id_var.reset(token)
            db_time_ms_var.reset(db_token)
