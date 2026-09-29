"""ApiRateLimitMiddleware caps /api/* per-IP, exempts /api/health."""

from __future__ import annotations

import importlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def app(monkeypatch):
    """Fresh limiter + small bucket for fast-running tests."""
    # Shrink the per-IP cap before importing the middleware so the test
    # exercises the 429 path in a handful of requests.
    monkeypatch.setattr("app.core.constants.API_RATE_LIMIT_REQUESTS", 3)
    monkeypatch.setattr("app.core.constants.API_RATE_LIMIT_WINDOW_SECONDS", 60)

    import app.auth.rate_limit as rl
    importlib.reload(rl)
    import app.core.middleware as mw
    importlib.reload(mw)

    app_ = FastAPI()
    app_.add_middleware(mw.ApiRateLimitMiddleware)

    @app_.get("/api/data")
    def data():
        return {"ok": True}

    @app_.get("/api/health")
    def health():
        return {"status": "ok"}

    return app_


def test_blocks_after_threshold(app):
    client = TestClient(app)
    for _ in range(3):
        assert client.get("/api/data").status_code == 200
    blocked = client.get("/api/data")
    assert blocked.status_code == 429
    assert blocked.headers.get("Retry-After")


def test_health_is_exempt(app):
    client = TestClient(app)
    for _ in range(10):
        assert client.get("/api/health").status_code == 200
