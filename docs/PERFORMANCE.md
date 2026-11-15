# Dashboard performance and archive restoration — 2026-11-08

## Review before implementation

The existing architecture uses SQLite indexed series, precomputed scenario evaluations and per-time/n-1 summaries,
backend TTL caches, gzip, lazy chart chunks and sections, progressive scenario loading, and virtualized tables.
These already avoid many full-data scans and expensive initial renders. Replacing the query engine would be a larger
change with mixed benefits for indexed lookups; the existing storage measurements are in [STORAGE.md](STORAGE.md).

Existing Parquet support exported one analysis through the CLI, with ZSTD, typed columns, UTC epoch times, a manifest,
checksums and immutable files. There was no import path or dashboard workflow. Jobs, catalog, LODF and cached scenario
evaluations were omitted; rebuilding the latter on reopen would scan raw data. Manifest validation could throw on
malformed structures and did not validate paths, completeness or column schemas. Export also used multiple read
snapshots, allowing a concurrent writer to change data between tables.

The browser response cache had no capacity limit, retained expired entries until accessed, and synchronously encoded
all cached responses after each insertion with a TTL over one minute. It continued that work even after exceeding the
storage quota threshold. Large time-series/chart responses therefore repeatedly blocked the main thread.

## Changes

- Browser cache: 64-entry LRU, expired-entry pruning, explicitly opted-in persistence only, encode each opted-in value
  once, maximum 256 Ki characters per persisted entry and 2 Mi characters total, writes coalesced over 100 ms.
  In-flight responses from before a cache clear cannot repopulate the new cache. Live chart data and returned values
  are unchanged; evicted data is fetched again as needed. These are entry/serialized-size limits, not a hard heap cap.
- Archive format 2 includes the jobs, catalog, relevant LODF and precomputed evaluations. The existing streaming
  exporter, ZSTD level 3 and typed schemas are reused. Exports read one SQLite transaction snapshot, use unique
  temporary folders and collision-resistant run filenames.
- Native QDS runs are included even when they have no scenario link, preventing silent omission of reference-only results.
- Restore verifies manifest shape, safe paths, table completeness, checksums, Parquet schemas and row counts;
  requires matching layout/result/state versions; streams 16,384 rows at a time into a new database; checks foreign
  keys, analysis ownership, run-file coverage and SQLite integrity before exclusive atomic publication. Failed
  restoration cleans temporary files and does not switch the selected database. Existing destinations are refused.
- Version 1 archives from the same schema/layout can also reopen: missing jobs are synthesized and omitted evaluations
  rebuild on demand. Their missing global catalog and browser context cannot be recovered.
- Local dashboard and CLI can export and reopen archives. Browser view, URL filters/time range and custom limits
  are stored in the manifest when exported from the dashboard and restored on reopen. Native calculation settings,
  provenance, run states and result metadata remain in their original tables. Local filesystem operations use the
  existing database-switch capability gate and remain disabled in production by default.

## Measurements

Synthetic data on this development machine, warm OS file cache; these are not production or cold-disk measurements.
Export and restore each include checksum validation. All archived tables, including raw values, were compared with
streamed canonical SHA-256 row digests after restoration; all matched. Small fixture tests also compare exact rows
including NULL, scenario indexes and derived evaluations.

| Dataset | Raw values | Source SQLite | Archive | Export | Restore |
|---|---:|---:|---:|---:|---:|
| 12 branches + 12 busbars, REF + 2 cases | 5,256 | 1.11 MB | 0.207 MB | 0.106 s | 0.039 s |
| 1,000 branches + 1,000 busbars, REF + 2 cases | 1,878,000 | 164.28 MB | 5.77 MB | 3.466 s | 6.967 s |

Sizes are decimal MB and include all archive files. The large archive was 96.5% smaller than its source database.
This is synthetic, repetitive data; real-data compression will differ. Restore rebuilds SQLite storage/indexes but
never reruns PowerFactory or numerical processing. It needs space for an expanded SQLite database, and remains O(rows).

Browser-cache microbenchmark: 40 responses × 10,000 timestamp/value points, default five-minute TTL, five trials.
The same payload/fetcher was used against the original and modified cache; fetch/network/render time is excluded.
Median insertion time fell from **1,556.8 ms to 0.144 ms**. Across five trials, payload serialization calls fell from
4,100 to zero because these responses did not explicitly request persistence. This measures removed cache overhead,
not total dashboard speed. Explicit persistence, batching, rejection retry, LRU eviction, request deduplication and
cache-clear races have separate regression tests. No total-page, chart FPS or peak-heap improvement is claimed.

Reproduce with a fresh output directory:

```sh
backend/.venv/bin/python backend/tests/archive_benchmark.py --out /tmp/gridlens-archive-benchmark
# Supply the path to a cache implementation; use a baseline checkout/file for comparison.
node --experimental-strip-types frontend/scripts/benchmark-cache.mjs "$PWD/frontend/src/api/cache.ts" 40 10000
```

Validation: 112 backend tests passed (including production launcher tests with local port access), archive corruption/reference/
version/path/snapshot/legacy tests; the final expanded archive suite passed 14 tests. Frontend typecheck, lint, 65 unit tests and production build also passed. Browser UI automation
could not run because the browser access host was unavailable; API integration tests cover save → restore → select →
read. A pre-existing build warning about the mixed static/dynamic import of api/client.ts remains.

Further opportunities: bound evaluation payloads when almost every asset is relevant; profile ISO timestamp payloads
and chart sampling with real annual datasets; consolidate repository connection lifetimes. Their benefit has not been
measured here. The future raw-Parquet/DuckDB storage decision in STORAGE.md remains a separate migration.
