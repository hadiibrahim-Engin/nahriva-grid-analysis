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
  persisted?: string;
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

const MAX_ENTRIES = 64;
const MAX_PERSISTED_CHARS = 2 * 1024 * 1024;
const MAX_ENTRY_CHARS = 256 * 1024;
let generation = 0;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function prune(): void {
  const now = Date.now();
  for (const [key, entry] of store) if (entry.expiresAt <= now) store.delete(key);
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value!);
}

const DEFAULT_TTL_MS = 5 * 60_000;

// -- sessionStorage persistence ----------------------------------------
const STORAGE_KEY = 'pf_simulation_cache_v1';

function loadFromStorage(): void {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    if (raw.length > MAX_PERSISTED_CHARS) { sessionStorage.removeItem(STORAGE_KEY); return; }
    const persisted = JSON.parse(raw) as Record<
      string,
      { expiresAt: number; value: unknown }
    >;
    const now = Date.now();
    for (const [key, entry] of Object.entries(persisted)) {
      if (entry && typeof entry.expiresAt === 'number' && entry.expiresAt > now) {
        const persisted = JSON.stringify(entry);
        if (persisted.length <= MAX_ENTRY_CHARS) store.set(key, { ...entry, persisted });
      }
    }
    prune();
  } catch {
    // sessionStorage unavailable (private browsing, quota, non-serialisable)
  }
}

function saveToStorage(): void {
  if (saveTimer !== undefined) return;
  // Coalesce a burst of completed requests. Values are encoded once, only on explicit opt-in.
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    prune();
    try {
      const entries: string[] = [];
      let size = 2;
      for (const [key, entry] of [...store].reverse()) {
        if (!entry.persisted) continue;
        const item = `${JSON.stringify(key)}:${entry.persisted}`;
        if (size + item.length + 1 > MAX_PERSISTED_CHARS) continue;
        size += item.length + 1;
        entries.push(item);
      }
      sessionStorage.setItem(STORAGE_KEY, `{${entries.join(',')}}`);
    } catch { /* privacy mode or quota: the memory cache still works */ }
  }, 100);
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
    if (entry && entry.expiresAt > now) {
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    }

    const pending = inflight.get(key) as InFlight<T> | undefined;
    if (pending) return pending.promise;
  } else {
    store.delete(key);
    const pending = inflight.get(key) as InFlight<T> | undefined;
    if (pending) return pending.promise;
  }

  const startedGeneration = generation;
  const promise = Promise.resolve().then(fetcher)
    .then((value) => {
      if (startedGeneration !== generation) return value;
      const entry: Entry<T> = { expiresAt: Date.now() + ttl, value };
      if (opts.persist) {
        try {
          const encoded = JSON.stringify(entry);
          if (encoded.length <= MAX_ENTRY_CHARS) entry.persisted = encoded;
        } catch { /* non-serialisable values remain in memory */ }
      }
      store.delete(key);
      store.set(key, entry);
      prune();
      if (opts.persist) saveToStorage();
      return value;
    })
    .finally(() => {
      if (inflight.get(key)?.promise === promise) inflight.delete(key);
    });

  inflight.set(key, { promise } as InFlight<unknown>);
  return promise;
}

/** Drop all cached entries (in-memory + sessionStorage). Used when the user clicks ↻. */
export function clearCache(): void {
  generation++;
  store.clear();
  inflight.clear();
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = undefined;
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/** Serialize an object of params into a stable cache-key suffix. */
export function paramsKey(params: Record<string, unknown>): string {
  const keys = Object.keys(params).sort();
  return keys.map((k) => `${k}=${String(params[k])}`).join('&');
}
