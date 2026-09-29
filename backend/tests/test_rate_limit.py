"""Login rate limiter behaviour."""

from __future__ import annotations

import importlib

import pytest
from fastapi import HTTPException


class FakeClient:
    def __init__(self, host: str) -> None:
        self.host = host


class FakeRequest:
    def __init__(self, host: str = "1.2.3.4", headers: dict[str, str] | None = None) -> None:
        self.client = FakeClient(host)
        self.headers = headers or {}


@pytest.fixture
def fresh_limiter():
    """Reload the module so each test starts with an empty counter."""
    import app.auth.rate_limit as rl
    importlib.reload(rl)
    return rl


def test_allows_under_threshold(fresh_limiter):
    for _ in range(5):
        fresh_limiter.login_rate_limit(FakeRequest())


def test_blocks_over_threshold_with_retry_after(fresh_limiter):
    req = FakeRequest()
    for _ in range(5):
        fresh_limiter.login_rate_limit(req)
    with pytest.raises(HTTPException) as exc:
        fresh_limiter.login_rate_limit(req)
    assert exc.value.status_code == 429
    assert int(exc.value.headers["Retry-After"]) > 0


def test_different_ips_are_independent(fresh_limiter):
    for _ in range(5):
        fresh_limiter.login_rate_limit(FakeRequest(host="1.1.1.1"))
    fresh_limiter.login_rate_limit(FakeRequest(host="2.2.2.2"))


def test_x_forwarded_for_is_honored(fresh_limiter):
    for proxy in ("10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5"):
        fresh_limiter.login_rate_limit(
            FakeRequest(host=proxy, headers={"x-forwarded-for": "5.5.5.5"})
        )
    with pytest.raises(HTTPException):
        fresh_limiter.login_rate_limit(
            FakeRequest(host="10.0.0.99", headers={"x-forwarded-for": "5.5.5.5"})
        )


def test_x_real_ip_is_honored(fresh_limiter):
    for _ in range(5):
        fresh_limiter.login_rate_limit(
            FakeRequest(host="10.0.0.1", headers={"x-real-ip": "6.6.6.6"})
        )
    with pytest.raises(HTTPException):
        fresh_limiter.login_rate_limit(
            FakeRequest(host="10.0.0.1", headers={"x-real-ip": "6.6.6.6"})
        )
