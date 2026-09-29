"""Application configuration.

The backend is Oracle/FDWH-oriented. This module keeps configuration loading
small and explicit so startup and debug scripts can report missing settings
without hiding the real error behind a failed dashboard request.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path
from urllib.parse import quote_plus

from app.core.constants import (
    DEFAULT_ACCESS_TOKEN_EXPIRE_MINUTES,
    DEFAULT_DB_HOST,
    DEFAULT_DB_PORT,
)


class ConfigError(RuntimeError):
    """Raised when required runtime configuration is missing or invalid."""


BASE_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BASE_DIR / ".env"


def _load_dotenv(path: Path = ENV_FILE) -> None:
    """Load simple KEY=VALUE pairs from backend/.env if present.

    This intentionally avoids adding another dependency just for local debug
    runs. Values already present in the process environment win.
    """

    if not path.is_file():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _env(*names: str, default: str = "") -> str:
    for name in names:
        value = os.getenv(name)
        if value is not None and value != "":
            return value
    return default


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {value!r}") from exc


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


_load_dotenv()

APP_ENV = _env("APP_ENV", default="development")

SECRET_KEY = _env("SECRET_KEY")
if SECRET_KEY in ("dev-secret-key-change-me", "change-this-to-a-random-64-char-hex-string"):
    raise ConfigError("Replace the example SECRET_KEY with a generated random key")
if APP_ENV == "production" and len(SECRET_KEY) < 32:
    raise ConfigError("Production requires a random SECRET_KEY of at least 32 characters")
# Ephemeral development tokens are invalidated at process restart.
SECRET_KEY = SECRET_KEY or secrets.token_hex(32)
AUTH_BACKEND = _env("AUTH_BACKEND", default="oracle")
LOCAL_USERNAME = _env("LOCAL_USERNAME")
LOCAL_PASSWORD_HASH = _env("LOCAL_PASSWORD_HASH")
if AUTH_BACKEND not in ("oracle", "local"):
    raise ConfigError("AUTH_BACKEND must be oracle or local")
if AUTH_BACKEND == "local" and (not LOCAL_USERNAME or not LOCAL_PASSWORD_HASH.startswith("scrypt$")):
    raise ConfigError("Local authentication requires LOCAL_USERNAME and LOCAL_PASSWORD_HASH")
ALGORITHM = _env("JWT_ALGORITHM", "ALGORITHM", default="HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = _env_int(
    "ACCESS_TOKEN_EXPIRE_MINUTES",
    DEFAULT_ACCESS_TOKEN_EXPIRE_MINUTES,
)

# Oracle target used for credential authentication.
DB_HOST = _env("DB_HOST", "ORACLE_HOST", default=DEFAULT_DB_HOST)
DB_PORT = _env("DB_PORT", "ORACLE_PORT", default=DEFAULT_DB_PORT)
DB_NAME = _env("DB_NAME", "ORACLE_SERVICE_NAME", "ORACLE_SID")

# Optional service account used by SQLAlchemy for dashboard queries.
DB_USER = _env("DB_USER", "ORACLE_USER")
DB_PASSWORD = _env("DB_PASSWORD", "ORACLE_PASSWORD")

# Cross-origin browser access. In the standard single-origin deployment the
# backend serves the built SPA itself (see main.py), so the browser never makes
# a cross-origin call and this can stay empty. Set it only when the frontend is
# hosted on a different origin (e.g. a separate CDN/domain): a comma-separated
# allow-list of exact origins, e.g. "https://dashb.example.com".
# In development the Vite dev server runs on a different port, so the example
# .env sets this to http://localhost:5174.
CORS_ORIGINS: list[str] = [
    o.strip() for o in _env("CORS_ORIGINS").split(",") if o.strip()
]

# Send HTTP Strict-Transport-Security. Only meaningful behind TLS, so it is off
# by default and should be enabled in production where the app is served over
# HTTPS (directly or via a reverse proxy that doesn't already add the header).
ENABLE_HSTS: bool = _env_bool("ENABLE_HSTS", False)

# Comma-separated usernames granted the "admin" role at login (System
# Analytics / metrics access). Case-insensitive. Empty by default → no
# admins, so the metrics endpoint is locked down until explicitly opened.
ADMIN_USERS: frozenset[str] = frozenset(
    u.strip().lower() for u in _env("ADMIN_USERS").split(",") if u.strip()
)


def is_admin_user(username: str) -> bool:
    return bool(username) and username.strip().lower() in ADMIN_USERS




def build_database_url() -> str:
    """Return SQLAlchemy URL for Oracle (oracledb thin), or the explicit DATABASE_URL."""

    explicit_url = os.getenv("DATABASE_URL", "")
    if explicit_url:
        return explicit_url

    if not (DB_USER and DB_PASSWORD and DB_HOST and DB_PORT and DB_NAME):
        return ""

    # Validate port early
    try:
        int(DB_PORT)
    except ValueError as exc:
        raise ConfigError(f"DB_PORT must be an integer, got {DB_PORT!r}") from exc

    # URL-encode credentials and service name to handle special chars (e.g., '+')
    user = quote_plus(DB_USER)
    password = quote_plus(DB_PASSWORD)
    host = DB_HOST.strip()
    port = DB_PORT.strip()
    service = quote_plus(DB_NAME)

    return f"oracle+oracledb://{user}:{password}@{host}:{port}/?service_name={service}"


DATABASE_URL = build_database_url()


def database_config_errors() -> list[str]:
    """Return missing settings that prevent dashboard DB queries."""

    if os.getenv("DATABASE_URL"):
        return []

    missing = []
    for label, value in {
        "DB_USER or ORACLE_USER": DB_USER,
        "DB_PASSWORD or ORACLE_PASSWORD": DB_PASSWORD,
        "DB_HOST or ORACLE_HOST": DB_HOST,
        "DB_PORT or ORACLE_PORT": DB_PORT,
        "DB_NAME or ORACLE_SERVICE_NAME": DB_NAME,
    }.items():
        if not value:
            missing.append(label)
    return missing


def auth_config_errors() -> list[str]:
    """Return missing settings that prevent Oracle credential login."""

    if AUTH_BACKEND == "local":
        return []
    errors = []
    if not DB_HOST:
        errors.append("DB_HOST or ORACLE_HOST")
    if not DB_PORT:
        errors.append("DB_PORT or ORACLE_PORT")
    if not DB_NAME:
        errors.append("DB_NAME or ORACLE_SERVICE_NAME")
    try:
        int(DB_PORT)
    except ValueError:
        errors.append("DB_PORT must be an integer")
    return errors


def get_database_url() -> str:
    errors = database_config_errors()
    if errors:
        joined = ", ".join(errors)
        raise ConfigError(
            "Missing database configuration for dashboard queries: "
            f"{joined}. Set DATABASE_URL or the DB_USER/DB_PASSWORD/DB_HOST/"
            "DB_PORT/DB_NAME variables."
        )
    return DATABASE_URL


def validate_auth_config() -> None:
    errors = auth_config_errors()
    if errors:
        raise ConfigError(
            "Missing Oracle authentication configuration: " + ", ".join(errors)
        )


def safe_summary() -> dict[str, str | int | bool | list[str]]:
    """Return non-secret config details for debug output."""

    return {
        "app_env": APP_ENV,
        "env_file": str(ENV_FILE),
        "env_file_exists": ENV_FILE.is_file(),
        "db_host": DB_HOST,
        "db_port": DB_PORT,
        "db_name": DB_NAME,
        "has_database_url": bool(os.getenv("DATABASE_URL")),
        "has_db_user": bool(DB_USER),
        "has_db_password": bool(DB_PASSWORD),
        "jwt_algorithm": ALGORITHM,
        "token_expire_minutes": ACCESS_TOKEN_EXPIRE_MINUTES,
        "database_config_errors": database_config_errors(),
        "auth_config_errors": auth_config_errors(),
        "duckdb_enabled": DUCKDB_ENABLED,
        "duckdb_path": DUCKDB_PATH if DUCKDB_ENABLED else "",
        "duckdb_fallback_to_oracle": DUCKDB_FALLBACK_TO_ORACLE,
        "duckdb_retention_years": DUCKDB_RETENTION_YEARS,
    }


# ----------------------------------------------------------------------
# DuckDB read-replica configuration (all optional, off by default).
#
# When DUCKDB_ENABLED=false (the default) the backend behaves exactly
# like the Oracle-only baseline: no DuckDB module is loaded at runtime,
# no file is required, and startup performs no DuckDB checks. See
# docs/duckdb-read-replica-plan.md for the full design.
# ----------------------------------------------------------------------

DUCKDB_ENABLED: bool = _env_bool("DUCKDB_ENABLED", False)
DUCKDB_PATH: str = _env("DUCKDB_PATH", default="")
DUCKDB_FALLBACK_TO_ORACLE: bool = _env_bool("DUCKDB_FALLBACK_TO_ORACLE", True)


def _env_int_tolerant(name: str, default: int, *, strict: bool) -> int:
    """Like ``_env_int`` but optionally swallows parse errors.

    When ``strict`` is false (i.e. the feature flag is off), a malformed
    value silently falls back to ``default``. This preserves the
    invariant that disabling DuckDB makes its other env vars irrelevant
    — operators can leave stale values around without breaking startup.
    """

    if strict:
        return _env_int(name, default)
    value = os.getenv(name)
    if value is None or value == "":
        return default
    try:
        return int(value)
    except ValueError:
        return default


DUCKDB_RETENTION_YEARS: int = _env_int_tolerant(
    "DUCKDB_RETENTION_YEARS", 3, strict=DUCKDB_ENABLED
)
DUCKDB_RECENT_RAW_MONTHS: int = _env_int_tolerant(
    "DUCKDB_RECENT_RAW_MONTHS", 3, strict=DUCKDB_ENABLED
)
DUCKDB_HOURLY_YEARS: int = _env_int_tolerant(
    "DUCKDB_HOURLY_YEARS", 3, strict=DUCKDB_ENABLED
)
DUCKDB_SYNC_MODE: str = _env("DUCKDB_SYNC_MODE", default="external")
DUCKDB_SYNC_DAY: str = _env("DUCKDB_SYNC_DAY", default="MONDAY")


def duckdb_config_errors() -> list[str]:
    """Return missing settings that prevent DuckDB use.

    Only reports errors when DUCKDB_ENABLED is true. With the flag off
    we never inspect any of the other DuckDB settings — the backend is
    a strict Oracle-only deployment.
    """

    if not DUCKDB_ENABLED:
        return []

    errors: list[str] = []
    if not DUCKDB_PATH:
        errors.append("DUCKDB_PATH is required when DUCKDB_ENABLED=true")
    if DUCKDB_RETENTION_YEARS <= 0:
        errors.append("DUCKDB_RETENTION_YEARS must be > 0")
    if DUCKDB_RECENT_RAW_MONTHS < 0:
        errors.append("DUCKDB_RECENT_RAW_MONTHS must be >= 0")
    if DUCKDB_HOURLY_YEARS <= 0:
        errors.append("DUCKDB_HOURLY_YEARS must be > 0")
    if DUCKDB_SYNC_MODE not in ("external", "internal"):
        errors.append("DUCKDB_SYNC_MODE must be 'external' or 'internal'")
    return errors
