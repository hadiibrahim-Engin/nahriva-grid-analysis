"""SecurityHeadersMiddleware attaches the hardening headers to every response."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from starlette.testclient import TestClient

from app.core.middleware import SecurityHeadersMiddleware, _SECURITY_HEADERS


def _make_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(SecurityHeadersMiddleware)

    @app.get("/probe")
    def probe():
        return {"ok": True}

    return app


def test_headers_present_on_response():
    client = TestClient(_make_app())
    response = client.get("/probe")
    assert response.status_code == 200
    for header in _SECURITY_HEADERS:
        assert header in response.headers, f"missing {header}"


def test_csp_blocks_frame_ancestors():
    client = TestClient(_make_app())
    csp = client.get("/probe").headers.get("content-security-policy", "")
    assert "frame-ancestors 'none'" in csp


def test_existing_headers_not_overridden():
    """If the handler returns a Response with its own headers, keep them."""
    app = FastAPI()
    app.add_middleware(SecurityHeadersMiddleware)

    @app.get("/probe")
    def probe():
        return JSONResponse({"ok": True}, headers={"X-Frame-Options": "SAMEORIGIN"})

    response = TestClient(app).get("/probe")
    assert response.headers["X-Frame-Options"] == "SAMEORIGIN"


def test_hsts_absent_by_default():
    """HSTS must not be sent unless explicitly enabled (TLS-only header)."""
    response = TestClient(_make_app()).get("/probe")
    assert "strict-transport-security" not in response.headers


def test_hsts_present_when_enabled():
    app = FastAPI()
    app.add_middleware(SecurityHeadersMiddleware, enable_hsts=True)

    @app.get("/probe")
    def probe():
        return {"ok": True}

    response = TestClient(app).get("/probe")
    hsts = response.headers.get("strict-transport-security", "")
    assert "max-age=31536000" in hsts
    assert "includeSubDomains" in hsts
