# Import and storage follow-up — 2026-11-15

The follow-up reduces wide-import latency and import RAM, adds complete cross-format sample access and serialized
crash recovery, and retains Parquet on archive restore. Redispatch is deferred at the user's request;
[REDISPATCH.md](REDISPATCH.md) tracks the open inputs. No native calculation/restoration or frontend code changed.

## Method and timing boundaries

The comparable baseline is commit `c8684b5`, including the earlier partial Arrow `RunTimes` optimization. The
21/34-second figures from the interrupted session are historical and are not used as this follow-up's baseline.
The same Python environment runs the source copies separately. Synthetic ElmRes stand-ins generate values in
Python. Their time says nothing about native `GetColumnValues`. Imports are single trials with a warm OS cache;
API calls run in a separate fresh process, 20 repeats after the first request. Reported MB are decimal.

The clock starts in the result consumer, which the runtime calls **after native calculation and verified state
restoration**. Those native phases are not timed by the stand-in import clock. REF, first scenario (including its
prepared evaluation), all QDS and all n-1 commits are separate events. The starter opens the browser after the
first scenario commit; `useAcrossData` then requests the index and evaluation, batches arrivals for 40 ms, and
renders. An already open dashboard polls for cases every 3 seconds. These are code observations, not browser
latency measurements. Actual browser startup, socket transfer, parsing/rendering and native Windows timing remain
unmeasured; a scenario commit is the earliest availability, not proof that a verdict was painted at that instant.

API timings include FastAPI, SQL, JSON/gzip and TestClient decoding, without a real socket or browser. First means
first call of that route in the request process; earlier routes may already warm shared caches. Snapshot requests
vary time/element and changed-limit requests vary limits. Response bytes are decompressed JSON. The raw reports
and commands are in [benchmarks/2026-11-15](benchmarks/2026-11-15/README.md).

## Before / after

| Measurement | 2,000 series × 6,073 h × 7 runs: before → after | 100,000 series × 73 h × 3 runs: before → after |
|---|---:|---:|
| Raw QDS values | 85,022,000 | 21,900,000 |
| REF committed | 8.32 → 8.76 s | 15.01 → 13.67 s |
| First scenario and evaluation committed | 17.49 → 17.77 s | **31.75 → 28.35 s** |
| Import complete | 61.83 → 62.47 s | **48.36 → 43.04 s** |
| Stand-in native reads | 49.56 → 49.59 s | 14.22 → 14.04 s |
| Processing excluding stand-in reads | 12.27 → 12.88 s | **34.14 → 29.00 s** |
| Import peak RSS | **485 → 357 MB** | **1,011 → 674 MB** |
| SQLite + values + metadata sidecars | 92.95 → 92.93 MB | 537.54 → 538.28 MB |
| API-process peak RSS | 456 → 418 MB | 3,841 → 3,687 MB |
| Scenario index P50 / P95 | 2.1 / 2.4 → 2.3 / 2.7 ms | 1.8 / 2.3 → 1.9 / 2.8 ms |
| Evaluation of all scenarios P50 / P95 | 89.4 / 97.5 → 88.6 / 92.2 ms | 395.6 / 415.4 → 395.3 / 414.9 ms |
| All-element snapshot P50 / P95 | 17.5 / 19.4 → 17.7 / 19.4 ms | 556.3 / 942.4 → 566.0 / 1,002.8 ms |
| Reduced asset series P50 / P95 | 14.3 / 34.4 → 13.5 / 30.4 ms | 5.4 / 7.4 → 6.2 / 6.7 ms |
| Evaluation with changed limits P50 / P95 | 110.2 / 149.2 → 108.9 / 135.2 ms | 2,602.3 / 2,971.5 → 2,396.5 / 3,061.3 ms |

The wide case improves first availability by 11% and peak import RAM by 33%. The longer case reduces RAM by 26%
but shows no time improvement. Small request differences are not evidence of a general speedup. The small file
size differences include random IDs/compression and SQLite page allocation, not a storage-format improvement.

Before/after exclusive phase seconds, wide case: Parquet write 4.93 → 3.49, sidecars 2.54 → 0.57, scenario evaluation
4.45 → 3.55, new in-memory scenario reduction 0 → 2.17, time reduction 2.89 → 1.79, Python/native metadata and SQLite
metadata inserts combined 18.06 → 16.15, commit 1.22 → 1.23, checksum 0.009 → 0.008. The residual metadata phase
includes object inspection, row construction and SQLite insertion; it is not a pure SQLite-insert measurement.
`RunStats` reduces rereading at the cost of another import reduction; windows are restricted to each run's consumers
and unused statistics/buffers are released. The time reducers have exact parity tests against SQL/per-value logic.

The first-scenario target **<10 s is still missed** in both main datasets. Most long-case time belongs to the Python
stand-in (about 50 of 62 seconds), which cannot predict native performance. In the wide case, metadata/object work
(~16 seconds), writing and materializing the large evaluation remain dominant. The index meets <200 ms; the wide
all-scenario evaluation (~11 MB JSON) misses it. A 100,000-element snapshot (~15 MB JSON) is around one second and
is broader than the target's one-area snapshot. Reduced time series meet <300 ms for these tested durations.
The next useful step is a measured bound/filter/page strategy for evaluation and snapshot payloads, then native
object/metadata profiling. No blanket request-time improvement or browser speedup is claimed.

The separate small fixture (100 series, 21,900 QDS samples and 6,483 sparse n-1 cells) completes import in
0.441 → 0.318 s and makes the first scenario available at 0.253 → 0.158 s, with import peak RSS 145 → 80 MB.
Its successful n-1-pairs request has P50/P95 5.7/7.0 → 5.6/6.9 ms, below the 500-ms target at this small size.
The main datasets contain no n-1 sweeps; their 404 request timings are excluded from acceptance. A populated
active-power/area performance measurement and real browser timing remain open.

## Archive restoration

The same corrected archive benchmark runs before and after. It compares every metadata table and every raw QDS
sample with canonical SHA-256 row digests across storage formats; all matched. Values remain immutable Parquet,
including archives exported from SQLite; n-1 cells and relationships still restore to SQLite. Validation includes
manifest, schema, checksums, row count, series ownership, duplicate raw keys, foreign keys and integrity. New
checks also cover publication failure, preserving old archives and deleting staged files on handled failure.


| Archive dataset | QDS values | Export before → after | Restore before → after | Restored SQLite + value files before → after |
|---|---:|---:|---:|---:|
| 12 branches + 12 busbars, REF + 2 cases, n-1 | 5,256 | 0.036 → 0.036 s | 0.044 → 0.141 s | 1.077 → 0.999 MB |
| 1,000 branches + 1,000 busbars, REF + 2 cases, n-1 | 1,878,000 | 1.309 → 1.214 s | **4.379 → 2.287 s** | **162.410 → 120.357 MB** |

The larger restore is 48% faster in this trial. Small restores are slower because of DuckDB setup/validation.
Copying raw Parquet avoids SQLite value expansion, but restoring large SQLite n-1/metadata tables still costs time.
A hard crash during two-file publication can leave an orphan folder without a published database; recovery and
retry semantics are documented in [DATABASE.md](DATABASE.md#interrupted-imports).

## Scale estimates and remaining acceptance

The tested 100,000-element case has only 73 hours and one variable per element; the long one has only 2,000
series. Neither measures 100,000 assets × 3 variables × a complete year (2.628 billion hourly values per run).
A purely linear projection from the long run's processing-only rate (85 million / 12.88 seconds) gives about
6.6 minutes processing per target run, or 26.5 minutes at quarter-hour resolution, **excluding native reads**.
This is an extrapolation, not a latency promise: metadata, multiple windows, RAM, disk, null distribution and
compression do not scale uniformly. It does not imply that the first scenario meets ten seconds at that size.
The existing storage estimate of 4–8 B/value would mean roughly 10.5–21 GB per hourly run, four times that at
quarter-hour resolution; it remains an estimate for real data. No billion-value fixture was generated.

141 backend tests passed, including real local production-launcher ports (outside the restrictive socket sandbox).
Ruff and `git diff --check` passed. Added coverage includes SQL/Arrow statistics parity with nulls and windows,
empty metrics/runs, import without a raw reread, pure SQLite/Parquet/mixed complete exports and CLI output,
parallel run builds on a shared repository, file replacement, layout 14 → 15, killed import owner/reacquisition,
orphan cleanup/reimport, legacy archive restore, foreign/duplicate raw rows and failed publication. Existing
peak/gap and UTC/DST tests remain green. Frontend files were unchanged; no new frontend build or rendering
benchmark is claimed. One dependency emits the existing Starlette/httpx deprecation warning.

Native PowerFactory 2026/Windows acceptance is still needed for ElmRes bulk API/return behavior, absolute and
relative UTC axes versus outage windows, active-power signs, compatible pyarrow in PowerFactory Python, Windows
lock ownership after termination, actual import RAM, disk/network-share behavior and browser first paint.
No Redispatch performance or energy-correctness result is claimed while that work is deferred.

---

## Historical review — 2026-11-08

The following describes the earlier SQLite-expanding restore and remains as historical measurement context.


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
