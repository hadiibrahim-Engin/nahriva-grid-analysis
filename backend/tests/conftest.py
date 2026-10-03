"""Shared pytest fixtures and import-path setup.

Simulation data and queued jobs use temporary SQLite databases in tests.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Make `import app.*` work when pytest is invoked from the backend dir.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture(autouse=True)
def _clear_analytics_cache():
    """The analytics LRU is module-level; isolate tests so a hit from one
    doesn't shadow a different FakeRepo wired up by the next."""
    from app.core.cache import analytics_cache

    analytics_cache.clear()
    yield
    analytics_cache.clear()
