"""TTLCache semantics."""

from __future__ import annotations

import time
import threading
from concurrent.futures import ThreadPoolExecutor

from app.core.cache import TTLCache


def test_returns_cached_value():
    cache = TTLCache(max_entries=4, ttl_seconds=60)
    calls = {"n": 0}

    def compute():
        calls["n"] += 1
        return "v"

    assert cache.get_or_compute("k", compute) == "v"
    assert cache.get_or_compute("k", compute) == "v"
    assert calls["n"] == 1
    assert cache.hits == 1
    assert cache.misses == 1


def test_evicts_expired_entries():
    cache = TTLCache(max_entries=4, ttl_seconds=0.01)
    cache.get_or_compute("k", lambda: 1)
    time.sleep(0.02)
    calls = {"n": 0}

    def recompute():
        calls["n"] += 1
        return 2

    assert cache.get_or_compute("k", recompute) == 2
    assert calls["n"] == 1


def test_lru_eviction_at_capacity():
    cache = TTLCache(max_entries=2, ttl_seconds=60)
    cache.get_or_compute("a", lambda: 1)
    cache.get_or_compute("b", lambda: 2)
    # Touch "a" so "b" becomes the LRU candidate.
    assert cache.get_or_compute("a", lambda: 99) == 1
    # Inserting "c" evicts the LRU entry ("b").
    cache.get_or_compute("c", lambda: 3)

    # "a" was touched, so it should still be cached.
    assert cache.get_or_compute("a", lambda: 999) == 1
    # "b" should have been evicted; lookup triggers a fresh compute.
    assert cache.get_or_compute("b", lambda: 222) == 222


def test_concurrent_misses_share_single_compute():
    cache = TTLCache(max_entries=4, ttl_seconds=60)
    started = threading.Event()
    release = threading.Event()
    calls = {"n": 0}

    def compute():
        calls["n"] += 1
        started.set()
        assert release.wait(timeout=1)
        return "v"

    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = [
            executor.submit(cache.get_or_compute, "k", compute)
            for _ in range(5)
        ]
        assert started.wait(timeout=1)
        release.set()
        assert [future.result(timeout=1) for future in futures] == ["v"] * 5

    assert calls["n"] == 1
    assert cache.misses == 1
    assert cache.hits == 4
