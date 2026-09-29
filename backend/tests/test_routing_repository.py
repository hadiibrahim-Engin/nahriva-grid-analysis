"""Phase 5: query routing between DuckDB and Oracle.

These tests use lightweight fakes for both repositories so they're
hermetic. The behaviour we pin here:

* dimension calls go to DuckDB
* measurement calls go to Oracle until Phase 6 implements them
* a DuckDB-coverage miss falls back to Oracle
* fallback can be disabled → DataNotAvailableError is raised
* every call logs its source

The critical invariant — when DUCKDB_ENABLED=false the routing layer
is bypassed entirely — is tested in ``test_duckdb_config.py`` and
``test_dependencies.py``.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

import pytest

from app.repositories.routing_repository import (
    DataNotAvailableError,
    RoutingRepository,
    _DUCKDB_IMPLEMENTED,
)


# -- fakes -----------------------------------------------------------


class FakeCoverage:
    def __init__(self, granularity: str | None = "hourly") -> None:
        self._g = granularity

    def pick_granularity(self, _start: datetime, _end: datetime) -> str | None:
        return self._g


class FakeDuckRepo:
    def __init__(self, coverage: FakeCoverage) -> None:
        self.coverage = coverage
        self.calls: list[tuple[str, tuple, dict]] = []

    # Dimension stubs returning identifiable rows so the test can assert
    # which backend served the call.
    def list_facilities(self) -> list[tuple]:
        self.calls.append(("list_facilities", (), {}))
        return [("DUCK", "from-duck")]

    def list_components_by_facility(self, facility_id: str) -> list[tuple]:
        self.calls.append(("list_components_by_facility", (facility_id,), {}))
        return [("F1", "duck-component", "MS")]

    def list_all_components(self) -> list[tuple]:
        self.calls.append(("list_all_components", (), {}))
        return []

    def component_name(self, anr: str, fnr: str) -> str:
        self.calls.append(("component_name", (anr, fnr), {}))
        return "duck-name"

    def date_range(self, anr: str, fnr: str) -> tuple:
        self.calls.append(("date_range", (anr, fnr), {}))
        return (datetime(2024, 1, 1), datetime(2024, 6, 1))

    def heatmap(self, *args: Any, **kwargs: Any) -> list[tuple]:
        self.calls.append(("heatmap", args, kwargs))
        return [("from-duck",)]


class FakeOracleRepo:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple, dict]] = []

    def list_facilities(self) -> list[tuple]:
        self.calls.append(("list_facilities", (), {}))
        return [("ORA", "from-oracle")]

    def list_components_by_facility(self, facility_id: str) -> list[tuple]:
        self.calls.append(("list_components_by_facility", (facility_id,), {}))
        return [("F1", "oracle-component", "MS")]

    def component_name(self, anr: str, fnr: str) -> str:
        self.calls.append(("component_name", (anr, fnr), {}))
        return "oracle-name"

    def date_range(self, anr: str, fnr: str) -> tuple:
        self.calls.append(("date_range", (anr, fnr), {}))
        return (datetime(2020, 1, 1), datetime(2026, 1, 1))

    def heatmap(self, *args: Any, **kwargs: Any) -> list[tuple]:
        self.calls.append(("heatmap", args, kwargs))
        return [("from-oracle",)]

    # The methods Phase 5 doesn't route — return placeholders for the
    # "always goes to Oracle" assertions.
    def count_points(self, *args: Any, **kwargs: Any) -> int:
        self.calls.append(("count_points", args, kwargs))
        return 42

    def statistics(self, *args: Any, **kwargs: Any) -> tuple:
        self.calls.append(("statistics", args, kwargs))
        return (1,)


# -- dimensions go to DuckDB -----------------------------------------


def test_list_facilities_routes_to_duckdb() -> None:
    duck = FakeDuckRepo(FakeCoverage())
    oracle = FakeOracleRepo()
    repo = RoutingRepository(duck, oracle)
    rows = repo.list_facilities()
    assert rows == [("DUCK", "from-duck")]
    assert duck.calls and not oracle.calls


def test_component_name_routes_to_duckdb() -> None:
    duck = FakeDuckRepo(FakeCoverage())
    oracle = FakeOracleRepo()
    repo = RoutingRepository(duck, oracle)
    assert repo.component_name("A1", "F1") == "duck-name"
    assert duck.calls and not oracle.calls


# -- measurement queries fall back until Phase 6 ---------------------


def test_count_points_always_oracle_today() -> None:
    """count_points isn't in _DUCKDB_IMPLEMENTED → always Oracle."""
    duck = FakeDuckRepo(FakeCoverage())
    oracle = FakeOracleRepo()
    repo = RoutingRepository(duck, oracle)
    params = {"anr": "A1", "fnr": "F1", "start": "2024-01-01 00:00:00", "end": "2024-02-01 00:00:00"}
    assert repo.count_points("P", params) == 42
    assert oracle.calls and not duck.calls


def test_statistics_always_oracle_today() -> None:
    duck = FakeDuckRepo(FakeCoverage())
    oracle = FakeOracleRepo()
    repo = RoutingRepository(duck, oracle)
    params = {"anr": "A1", "fnr": "F1", "start": "2024-01-01 00:00:00", "end": "2024-02-01 00:00:00"}
    repo.statistics("P", params)
    assert oracle.calls and not duck.calls


# -- coverage miss falls back to Oracle ------------------------------


def test_uncovered_window_falls_back_when_method_is_implemented(monkeypatch) -> None:
    """If we add heatmap to _DUCKDB_IMPLEMENTED, a miss must hit Oracle."""
    monkeypatch.setattr(
        "app.repositories.routing_repository._DUCKDB_IMPLEMENTED",
        _DUCKDB_IMPLEMENTED | {"heatmap"},
    )
    duck = FakeDuckRepo(FakeCoverage(granularity=None))  # no coverage
    oracle = FakeOracleRepo()
    repo = RoutingRepository(duck, oracle)
    params = {"anr": "A1", "fnr": "F1", "start": "2024-01-01 00:00:00", "end": "2024-02-01 00:00:00"}
    rows = repo.heatmap("P", params)
    assert rows == [("from-oracle",)]


def test_fallback_disabled_raises(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.repositories.routing_repository._DUCKDB_IMPLEMENTED",
        _DUCKDB_IMPLEMENTED | {"heatmap"},
    )
    duck = FakeDuckRepo(FakeCoverage(granularity=None))
    oracle = FakeOracleRepo()
    repo = RoutingRepository(duck, oracle, fallback_to_oracle=False)
    params = {"anr": "A1", "fnr": "F1", "start": "2024-01-01 00:00:00", "end": "2024-02-01 00:00:00"}
    with pytest.raises(DataNotAvailableError):
        repo.heatmap("P", params)


def test_duckdb_exception_falls_back_to_oracle(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.repositories.routing_repository._DUCKDB_IMPLEMENTED",
        _DUCKDB_IMPLEMENTED | {"heatmap"},
    )

    class ExplodingDuck(FakeDuckRepo):
        def heatmap(self, *_args: Any, **_kwargs: Any) -> list[tuple]:
            raise RuntimeError("duckdb broken")

    duck = ExplodingDuck(FakeCoverage(granularity="hourly"))
    oracle = FakeOracleRepo()
    repo = RoutingRepository(duck, oracle)
    params = {"anr": "A1", "fnr": "F1", "start": "2024-01-01 00:00:00", "end": "2024-02-01 00:00:00"}
    rows = repo.heatmap("P", params)
    assert rows == [("from-oracle",)]


# -- logging ---------------------------------------------------------


def test_every_call_logs_source(caplog: pytest.LogCaptureFixture) -> None:
    duck = FakeDuckRepo(FakeCoverage())
    oracle = FakeOracleRepo()
    repo = RoutingRepository(duck, oracle)
    with caplog.at_level(logging.INFO, logger="app.repositories.routing_repository"):
        repo.list_facilities()
    assert any("query.source=duckdb" in r.message for r in caplog.records)


def test_oracle_route_logs_source(caplog: pytest.LogCaptureFixture) -> None:
    duck = FakeDuckRepo(FakeCoverage())
    oracle = FakeOracleRepo()
    repo = RoutingRepository(duck, oracle)
    with caplog.at_level(logging.INFO, logger="app.repositories.routing_repository"):
        params = {"anr": "A1", "fnr": "F1", "start": "2024-01-01 00:00:00", "end": "2024-02-01 00:00:00"}
        repo.count_points("P", params)
    assert any("query.source=oracle" in r.message and "method=count_points" in r.message
               for r in caplog.records)


# -- dependency factory invariant -----------------------------------


def test_disabled_mode_returns_plain_fdwh_repository(monkeypatch) -> None:
    """The single most important invariant of the entire feature."""
    monkeypatch.setenv("DUCKDB_ENABLED", "false")
    import importlib

    import app.config
    import app.api.dependencies as deps
    importlib.reload(app.config)
    importlib.reload(deps)

    class _FakeSession:
        pass

    repo = deps.get_fdwh_repository(_FakeSession())
    from app.repositories.fdwh_repository import FDWHRepository
    assert isinstance(repo, FDWHRepository)
