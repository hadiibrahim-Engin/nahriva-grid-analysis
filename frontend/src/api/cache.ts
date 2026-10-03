/**
 * In-memory TTL cache with request deduplication and sessionStorage
 * persistence.
 *
 * Why this exists: switching tabs or refreshing the page re-fires 5-10
 * expensive simulation GETs that already returned identical data seconds ago.
 * This module wraps async fetchers so:
 *   • repeated calls within `ttlMs` return the cached value (or join the
 *     in-flight promise), and
 *   • the cache survives a page refresh via sessionStorage, making
 *     same-session return-visits feel instant.
 *
 * Not a full React Query replacement — no background revalidation, no
 * subscriptions, no devtools. Deliberately small.
 */

// -- Types -------------------------------------------------------------
interface Entry<T> {
  expiresAt: number;
  value: T;
}

interface InFlight<T> {
  promise: Promise<T>;
}

export interface CacheOptions {
  /** Override TTL in ms; default 5 min. */
  ttlMs?: number;
  /** Bypass the cached value and force a fresh fetch (still populates cache). */
  force?: boolean;
  /** If true, persist this entry to sessionStorage so it survives page refresh. */
  persist?: boolean;
}

// -- In-memory store ---------------------------------------------------
const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, InFlight<unknown>>();

const DEFAULT_TTL_MS = 5 * 60_000;

// -- sessionStorage persistence ----------------------------------------
const STORAGE_KEY = 'pf_simulation_cache_v1';

function loadFromStorage(): void {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const persisted = JSON.parse(raw) as Record<
      string,
      { expiresAt: number; value: unknown }
    >;
    const now = Date.now();
    for (const [key, entry] of Object.entries(persisted)) {
      if (typeof entry.expiresAt === 'number' && entry.expiresAt > now) {
        store.set(key, entry as Entry<unknown>);
      }
    }
  } catch {
    // sessionStorage unavailable (private browsing, quota, non-serialisable)
  }
}

function saveToStorage(): void {
  try {
    const now = Date.now();
    const obj: Record<string, { expiresAt: number; value: unknown }> = {};
    for (const [key, entry] of store.entries()) {
      if (entry.expiresAt > now) {
        obj[key] = entry;
      }
    }
    const serialised = JSON.stringify(obj);
    // Skip if >4 MB to avoid QuotaExceededError; in-memory cache still works.
    if (serialised.length < 4 * 1024 * 1024) {
      sessionStorage.setItem(STORAGE_KEY, serialised);
    }
  } catch {
    // Quota exceeded or sessionStorage disabled — gracefully degrade.
  }
}

// Hydrate from sessionStorage once at module init (runs synchronously at import)
loadFromStorage();

// -- Core withCache ----------------------------------------------------

/**
 * Wrap a thunk so repeated calls within `ttlMs` return the same value.
 * Concurrent calls share the same in-flight promise.
 *
 * `key` must uniquely identify the request (URL + params).
 */
export async function withCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts: CacheOptions = {},
): Promise<T> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();

  if (!opts.force) {
    const entry = store.get(key) as Entry<T> | undefined;
    if (entry && entry.expiresAt > now) return entry.value;

    const pending = inflight.get(key) as InFlight<T> | undefined;
    if (pending) return pending.promise;
  } else {
    store.delete(key);
    const pending = inflight.get(key) as InFlight<T> | undefined;
    if (pending) return pending.promise;
  }

  const promise = fetcher()
    .then((value) => {
      store.set(key, { expiresAt: Date.now() + ttl, value });
      // Persist analytics entries (persist:true) or anything over 1 min TTL
      if (opts.persist || ttl > 60_000) {
        saveToStorage();
      }
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, { promise } as InFlight<unknown>);
  return promise;
}

/** Drop all cached entries (in-memory + sessionStorage). Used when the user clicks ↻. */
export function clearCache(): void {
  store.clear();
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/** Serialize an object of params into a stable cache-key suffix. */
export function paramsKey(params: Record<string, unknown>): string {
  const keys = Object.keys(params).sort();
  return keys.map((k) => `${k}=${String(params[k])}`).join('&');
}
