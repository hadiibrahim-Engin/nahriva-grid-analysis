"""Tiny in-process TTL+LRU cache for analytics responses.

HTTP Cache-Control lets one browser dodge repeats; this layer dodges
Oracle work when *different* users hit the same window in quick
succession (common when multiple operators inspect the same trafo).

Keep the TTL short — minutes, not hours — so freshly-arrived
measurements still surface within a tab switch.

Thread-safe via a single lock around the OrderedDict; fine for the
dashboard's read-mostly workload. For multi-instance deployments, swap
to Redis behind the same interface.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from typing import Any, Callable, TypeVar

T = TypeVar("T")


class TTLCache:
    """LRU + TTL. Eviction happens on get and on insert."""

    def __init__(self, *, max_entries: int, ttl_seconds: float) -> None:
        self._max = max_entries
        self._ttl = ttl_seconds
        self._store: OrderedDict[Any, tuple[float, Any]] = OrderedDict()
        self._inflight: dict[Any, threading.Event] = {}
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    def get_or_compute(self, key: Any, compute: Callable[[], T]) -> T:
        while True:
            now = time.monotonic()
            with self._lock:
                entry = self._store.get(key)
                if entry is not None:
                    expires_at, value = entry
                    if expires_at > now:
                        self._store.move_to_end(key)
                        self.hits += 1
                        return value
                    self._store.pop(key, None)

                pending = self._inflight.get(key)
                if pending is None:
                    pending = threading.Event()
                    self._inflight[key] = pending
                    self.misses += 1
                    break

            # Another thread is already doing this expensive read. Wait until
            # it fills the cache, then loop back through the normal cache path.
            pending.wait()

        try:
            # Compute outside the lock so slow Oracle queries don't block other tenants.
            value = compute()
        except BaseException:
            with self._lock:
                pending = self._inflight.pop(key, None)
                if pending is not None:
                    pending.set()
            raise

        with self._lock:
            self._store[key] = (time.monotonic() + self._ttl, value)
            self._store.move_to_end(key)
            while len(self._store) > self._max:
                self._store.popitem(last=False)
            pending = self._inflight.pop(key, None)
            if pending is not None:
                pending.set()
        return value

    def clear(self) -> None:
        with self._lock:
            self._store.clear()


# Shared cache for analytics service results. 512 entries at a few KB
# each is well under a MB.
analytics_cache = TTLCache(max_entries=512, ttl_seconds=1800)


def cached(method):
    """Memoize a service method on (method_name, args, kwargs).

    All positional args after `self` must be hashable. Uses the
    module-level `analytics_cache`; the service class and method name are
    part of the key, so different services can safely share the same instance.
    """

    name = method.__name__

    def wrapper(self, *args, **kwargs):
        key = (self.__class__.__qualname__, name, args, tuple(sorted(kwargs.items())))
        return analytics_cache.get_or_compute(key, lambda: method(self, *args, **kwargs))

    wrapper.__name__ = name
    wrapper.__doc__ = method.__doc__
    wrapper.__wrapped__ = method  # type: ignore[attr-defined]
    return wrapper
