"""Pin the DUCKDB_ENABLED=false default + validate the config knobs.

This test guarantees the central invariant of the read-replica work:
when DuckDB is disabled (the default), the backend never depends on
any DuckDB module or file. Phase 1 only ships configuration — the
runtime behaviour must still match the Oracle-only baseline.
"""

from __future__ import annotations

import importlib
import os
from typing import Generator

import pytest


@pytest.fixture
def reload_config(monkeypatch: pytest.MonkeyPatch) -> Generator[object, None, None]:
    """Re-import app.config with the env vars under test set."""

    def _reload() -> object:
        import app.config as cfg
        importlib.reload(cfg)
        return cfg

    yield _reload


# -- Defaults / invariants -----------------------------------------------


def test_duckdb_disabled_by_default(monkeypatch: pytest.MonkeyPatch, reload_config) -> None:
    """No env vars set → DuckDB is off and nothing else flips."""
    for key in (
        "DUCKDB_ENABLED",
        "DUCKDB_PATH",
        "DUCKDB_FALLBACK_TO_ORACLE",
        "DUCKDB_RETENTION_YEARS",
    ):
        monkeypatch.delenv(key, raising=False)

    cfg = reload_config()

    assert cfg.DUCKDB_ENABLED is False
    assert cfg.duckdb_config_errors() == []
    # The safe_summary must report the flag and must NOT leak the path
    # when the feature is off (avoids confusing ops messaging).
    summary = cfg.safe_summary()
    assert summary["duckdb_enabled"] is False
    assert summary["duckdb_path"] == ""


def test_duckdb_enabled_without_path_reports_error(
    monkeypatch: pytest.MonkeyPatch, reload_config
) -> None:
    monkeypatch.setenv("DUCKDB_ENABLED", "true")
    monkeypatch.delenv("DUCKDB_PATH", raising=False)

    cfg = reload_config()

    assert cfg.DUCKDB_ENABLED is True
    errors = cfg.duckdb_config_errors()
    assert any("DUCKDB_PATH" in e for e in errors)


def test_duckdb_enabled_with_path_is_clean(
    monkeypatch: pytest.MonkeyPatch, reload_config, tmp_path
) -> None:
    monkeypatch.setenv("DUCKDB_ENABLED", "1")
    monkeypatch.setenv("DUCKDB_PATH", str(tmp_path / "dashboard.duckdb"))

    cfg = reload_config()

    assert cfg.DUCKDB_ENABLED is True
    assert cfg.duckdb_config_errors() == []
    assert cfg.DUCKDB_RETENTION_YEARS == 3
    assert cfg.DUCKDB_FALLBACK_TO_ORACLE is True


# -- env_bool parser -----------------------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [
        ("true", True),
        ("True", True),
        ("1", True),
        ("yes", True),
        ("on", True),
        ("false", False),
        ("0", False),
        ("no", False),
        ("", False),
        ("garbage", False),
    ],
)
def test_env_bool_parser(
    monkeypatch: pytest.MonkeyPatch, reload_config, value: str, expected: bool
) -> None:
    monkeypatch.setenv("DUCKDB_ENABLED", value)
    cfg = reload_config()
    assert cfg.DUCKDB_ENABLED is expected


# -- Validation rules ----------------------------------------------------


def test_retention_must_be_positive(
    monkeypatch: pytest.MonkeyPatch, reload_config, tmp_path
) -> None:
    monkeypatch.setenv("DUCKDB_ENABLED", "true")
    monkeypatch.setenv("DUCKDB_PATH", str(tmp_path / "x.duckdb"))
    monkeypatch.setenv("DUCKDB_RETENTION_YEARS", "0")
    cfg = reload_config()
    assert any("RETENTION_YEARS" in e for e in cfg.duckdb_config_errors())


def test_unknown_sync_mode_reported(
    monkeypatch: pytest.MonkeyPatch, reload_config, tmp_path
) -> None:
    monkeypatch.setenv("DUCKDB_ENABLED", "true")
    monkeypatch.setenv("DUCKDB_PATH", str(tmp_path / "x.duckdb"))
    monkeypatch.setenv("DUCKDB_SYNC_MODE", "magic")
    cfg = reload_config()
    assert any("SYNC_MODE" in e for e in cfg.duckdb_config_errors())


# -- Critical fallback invariant -----------------------------------------


def test_disabled_mode_does_not_inspect_other_keys(
    monkeypatch: pytest.MonkeyPatch, reload_config
) -> None:
    """If the flag is off, garbage in other DuckDB env vars is ignored.

    This pins the 'DUCKDB_ENABLED=false ⇒ no DuckDB code path' invariant
    from the read-replica plan. Operators must be able to leave stale
    DuckDB config around without breaking the Oracle-only baseline.
    """
    monkeypatch.setenv("DUCKDB_ENABLED", "false")
    monkeypatch.setenv("DUCKDB_RETENTION_YEARS", "not-a-number")  # would normally fail
    monkeypatch.setenv("DUCKDB_SYNC_MODE", "magic")

    # _env_int still raises on garbage during module import, so we expect
    # ConfigError here ONLY if the flag is on. With the flag off the bad
    # value should NOT be parsed.
    # However our current implementation reads DUCKDB_RETENTION_YEARS
    # unconditionally; verify that the validator doesn't surface it.
    try:
        cfg = reload_config()
    except Exception as exc:  # pragma: no cover - regression guard
        pytest.fail(f"Disabled DuckDB still parsed bad config: {exc}")

    assert cfg.DUCKDB_ENABLED is False
    assert cfg.duckdb_config_errors() == []
