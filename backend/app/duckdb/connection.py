"""Read-only DuckDB connection helper with an mtime-aware re-open hook.

The dashboard process keeps a long-lived read-only handle on
``dashboard.duckdb``. The weekly sync job replaces the file atomically
(see plan §4.3). After the swap, the inode the dashboard has open is
the *old* file — so we periodically ``stat()`` the active path and
re-open when the modification time advances.

Reads happen *outside* any lock to keep the dashboard responsive.
Re-opens are guarded by a single ``threading.Lock`` so concurrent
swap detection is safe.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

log = logging.getLogger(__name__)


class DuckDBHandle:
    """Read-only DuckDB connection that auto-reopens after an atomic swap.

    Intentionally minimal — DuckDB's own connection object is already
    thread-safe for reads, so we don't pool. We just guarantee freshness.
    """

    def __init__(self, path: str) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._con: Any | None = None
        self._mtime_ns: int = 0

    # -- lifecycle ----------------------------------------------------

    def _open(self) -> None:
        """Open a fresh read-only handle on the active file."""
        try:
            mtime = os.stat(self._path).st_mtime_ns
        except FileNotFoundError as exc:
            raise FileNotFoundError(
                f"DuckDB file not found at {self._path!r}. "
                "Run the bootstrap script before enabling the read replica."
            ) from exc

        import duckdb  # imported lazily so disabled-mode never loads it

        con = duckdb.connect(self._path, read_only=True)
        # Replace the previous handle only after the new one is ready,
        # so any concurrent read keeps working against the old handle.
        old = self._con
        self._con = con
        self._mtime_ns = mtime
        if old is not None:
            try:
                old.close()
            except Exception:  # pragma: no cover - best effort
                log.debug("ignored error closing old duckdb handle", exc_info=True)

    def _ensure_fresh(self) -> None:
        """Re-open the connection if the underlying file changed.

        Cheap (a single ``stat``) so it's safe to call before every
        query. The re-open itself is rare (≈ once a week, after the
        sync swap).
        """
        try:
            current_mtime = os.stat(self._path).st_mtime_ns
        except FileNotFoundError:
            # File disappeared between syncs — drop the handle and let
            # the next call raise a clean error from _open().
            with self._lock:
                if self._con is not None:
                    try:
                        self._con.close()
                    except Exception:  # pragma: no cover
                        pass
                    self._con = None
            raise

        if self._con is None or current_mtime != self._mtime_ns:
            with self._lock:
                # Re-check under the lock to avoid double-opens under contention.
                if self._con is None or current_mtime != self._mtime_ns:
                    self._open()

    # -- public read API ----------------------------------------------

    def execute(self, sql: str, params: list[Any] | tuple[Any, ...] | None = None):
        """Run a SQL statement and return the DuckDB cursor."""
        self._ensure_fresh()
        assert self._con is not None  # _ensure_fresh guarantees this
        if params is None:
            return self._con.execute(sql)
        return self._con.execute(sql, params)

    def fetchall(self, sql: str, params: list[Any] | tuple[Any, ...] | None = None) -> list[tuple]:
        return self.execute(sql, params).fetchall()

    def fetchone(self, sql: str, params: list[Any] | tuple[Any, ...] | None = None) -> tuple | None:
        return self.execute(sql, params).fetchone()

    def close(self) -> None:
        with self._lock:
            if self._con is not None:
                try:
                    self._con.close()
                except Exception:  # pragma: no cover
                    log.debug("ignored error closing duckdb handle", exc_info=True)
                self._con = None
                self._mtime_ns = 0


# -- module-level singleton (lazy) ------------------------------------

_handle: DuckDBHandle | None = None
_handle_lock = threading.Lock()


def get_duckdb_handle(path: str) -> DuckDBHandle:
    """Return a process-wide DuckDB handle keyed by file path.

    Re-opens the handle when the active file path changes (e.g. tests
    pointing at tmp files).
    """
    global _handle
    with _handle_lock:
        if _handle is None or _handle._path != path:
            if _handle is not None:
                _handle.close()
            _handle = DuckDBHandle(path)
        return _handle


def reset_duckdb_handle() -> None:
    """Drop the singleton handle. Used by tests; not called in prod."""
    global _handle
    with _handle_lock:
        if _handle is not None:
            _handle.close()
        _handle = None
