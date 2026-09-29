"""Metrics collector + admin RBAC gate."""

from __future__ import annotations

import pytest
from starlette.testclient import TestClient

from app.auth.auth import create_access_token
from app.core.metrics import MetricsCollector, classify_mode, metrics_collector


# -- collector -------------------------------------------------------

def test_collector_percentiles_and_modes():
    c = MetricsCollector()
    for i in range(100):
        c.record(
            endpoint="/api/timeseries/raw/{component_id}/{measurement_type}",
            method="GET", status=200, duration_ms=float(i + 1), db_ms=float(i) / 2,
            mode="raw", size=100,
        )
    c.record(endpoint="/x", method="GET", status=500, duration_ms=10, db_ms=1, mode="other", size=0)
    s = c.summary()
    assert s["total_requests"] == 101
    assert s["measurement_modes"]["raw"] == 100
    assert s["latency_ms"]["p50"] <= s["latency_ms"]["p95"] <= s["latency_ms"]["p99"]
    assert s["status_classes"]["server_errors_5xx"] == 1
    assert 0 < s["error_rate"] < 0.02
    assert any(e["endpoint"].endswith("{measurement_type}") for e in s["top_endpoints"])


def test_collector_counts_timeouts():
    c = MetricsCollector()
    c.record(endpoint="/a", method="GET", status=504, duration_ms=90000, db_ms=90000, mode="raw", size=0)
    assert c.summary()["timeouts"] == 1


def test_classify_mode():
    assert classify_mode("/api/timeseries/raw/A_F/P") == "raw"
    assert classify_mode("/api/timeseries/aggregate/A_F/P") == "aggregated"
    assert classify_mode("/api/export/A_F") == "export"
    assert classify_mode("/api/facilities") == "other"


def test_is_admin_user(monkeypatch):
    import app.config as config

    monkeypatch.setattr(config, "ADMIN_USERS", frozenset({"alice"}))
    assert config.is_admin_user("Alice") is True
    assert config.is_admin_user("bob") is False
    assert config.is_admin_user("") is False


# -- admin gate (integration) ----------------------------------------

@pytest.fixture
def client():
    from app.main import app
    from app.auth import rate_limit

    metrics_collector.reset()
    # Isolate from other suites that share the module-level per-IP limiter.
    rate_limit._api_limiter._entries.clear()
    rate_limit._login_limiter._entries.clear()
    return TestClient(app)


def _auth(role: str) -> dict:
    token = create_access_token(data={"sub": "u", "role": role})
    return {"Authorization": f"Bearer {token}"}


def test_metrics_requires_auth(client):
    assert client.get("/api/metrics/summary").status_code == 401


def test_metrics_visible_to_any_authenticated_user(client):
    # System Analytics is transparent for all signed-in users (not admin-gated).
    res = client.get("/api/metrics/summary", headers=_auth("viewer"))
    assert res.status_code == 200
    body = res.json()
    assert "latency_ms" in body and "measurement_modes" in body
    # Each request is recorded after its handler runs, so a second call
    # sees the first one reflected in the rolling window.
    res2 = client.get("/api/metrics/summary", headers=_auth("viewer"))
    assert res2.json()["total_requests"] >= 1


def test_require_admin_dependency_enforces_role():
    """The RBAC building block still works for any future admin-only route."""
    from app.auth.auth import require_admin
    from app.core.errors import ForbiddenError
    from app.models.models import User

    assert require_admin(User(username="a", role="admin")).role == "admin"
    with pytest.raises(ForbiddenError):
        require_admin(User(username="v", role="viewer"))
