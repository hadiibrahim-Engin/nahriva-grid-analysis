"""QA suite for power-factor analytics — fachliche Korrektheit + Edge Cases.

Reuses the FakeRepo harness from test_analytics_service so no DB is needed.
The point of THIS file (vs. the existing smoke test) is to pin down the
*business* rules: which inputs are required, what must happen when they are
missing/garbage, and that NaN/Infinity never leak into the response.

Required inputs for cos φ / tan φ in this scalar system (derived from
analytics_service.get_power_factor + db/queries.power_factor_downsampled):

    cos φ = P / S   → requires P (MW) and S (S);  S ≠ 0
    tan φ = Q / P   → requires Q (BMW) and P (MW); P ≠ 0

The production SQL filters `MW/BMW/S IS NOT NULL`, so a real row always has
all three. These tests exercise the SERVICE in isolation, which is exactly
where a future query/repo change (or the mock repo) could reintroduce the
silent-zero hazard.
"""

from __future__ import annotations

import math
from datetime import datetime
from decimal import Decimal

import pytest

from app.core.errors import ResourceNotFoundError
from app.services.analytics_service import AnalyticsService
from tests.test_analytics_service import FakeRepo

T0 = datetime(2025, 1, 1, 10, 0)
T1 = datetime(2025, 1, 1, 10, 15)


def _pf(rows):
    return AnalyticsService(FakeRepo(power_factor=rows)).get_power_factor(
        "A1_F1", None, None, downsample_minutes=15
    )


# -- Correct math ----------------------------------------------------

def test_cos_phi_and_tan_phi_correct():
    # P=80, Q=60, S=100  → cos=0.8, tan=0.75
    resp = _pf([(T0, 80.0, 60.0, 100.0)])
    assert resp.data[0].cos_phi == pytest.approx(0.8)
    assert resp.data[0].tan_phi == pytest.approx(0.75)


def test_cos_phi_clamped_to_unit_interval():
    # Measurement noise can push P slightly above S; cos φ must stay ≤ 1.
    resp = _pf([(T0, 105.0, 0.0, 100.0)])
    assert resp.data[0].cos_phi == pytest.approx(1.0)


def test_decimal_inputs_accepted():
    resp = _pf([(T0, Decimal("80"), Decimal("60"), Decimal("100"))])
    assert resp.data[0].cos_phi == pytest.approx(0.8)


# -- Division by zero ------------------------------------------------

def test_zero_apparent_power_yields_none_not_inf():
    # S = 0 → cos φ undefined. Must be None, never inf/NaN.
    resp = _pf([(T0, 80.0, 60.0, 0.0)])
    assert resp.data[0].cos_phi is None


def test_zero_active_power_yields_none_tan_phi():
    # P = 0 → tan φ undefined.
    resp = _pf([(T0, 0.0, 60.0, 100.0)])
    assert resp.data[0].tan_phi is None


# -- Empty data ------------------------------------------------------

def test_empty_window_raises_not_found():
    # No rows at all → clear 404, not an empty 200 that renders as a blank plot.
    with pytest.raises(ResourceNotFoundError):
        _pf([])


# -- Garbage inputs: NaN / Infinity / missing ------------------------
# Acceptance criteria: "Fehlende Werte dürfen nicht stillschweigend als 0
# interpretiert werden" and "NaN, Infinity ... dürfen nicht unkontrolliert
# im Plot erscheinen."

def test_nan_active_power_yields_none_not_fabricated_unity():
    # Previously the clamp turned NaN into a plausible cos φ = 1.0. Now None.
    resp = _pf([(T0, float("nan"), 60.0, 100.0)])
    assert resp.data[0].cos_phi is None


def test_missing_active_power_is_not_treated_as_zero_and_does_not_crash():
    # None P must not crash (round(None)) and must not report cos φ = 0.
    resp = _pf([(T0, None, 60.0, 100.0)])
    assert resp.data[0].cos_phi is None
    assert resp.data[0].p is None


def test_infinite_input_does_not_leak():
    resp = _pf([(T0, float("inf"), 60.0, 100.0)])
    cos = resp.data[0].cos_phi
    assert cos is None or math.isfinite(cos)
    assert resp.data[0].p is None


def test_tan_phi_nan_does_not_leak():
    # tan φ is now sanitized like cos φ — no unbounded NaN leak.
    resp = _pf([(T0, 80.0, float("nan"), 100.0)])
    tan = resp.data[0].tan_phi
    assert tan is None or math.isfinite(tan)
