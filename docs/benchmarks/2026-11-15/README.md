# Import/storage follow-up — 2026-11-15

Synthetic PowerFactory stand-ins, separate import and API processes, warm OS file cache. These are single import
trials; API P50/P95 uses 20 repeats after a separate first request. They do not measure native ElmRes latency,
network transfer or browser rendering. Decimal MB. `before` uses commit `c8684b5`, which already includes the earlier
partial Arrow RunTimes optimization. `after` uses the working-tree follow-up described in PERFORMANCE.md.

Main import commands (run from `backend`, using the same environment for both source trees):

```sh
.venv/bin/python -m tests.import_benchmark --out /tmp/bench-wide --branches 50000 --cases 2 --contingencies 0 --window 24 --spacing 48 --repeats 20
.venv/bin/python -m tests.import_benchmark --out /tmp/bench-year --branches 1000 --cases 6 --contingencies 0 --window 72 --repeats 20
.venv/bin/python -m tests.import_benchmark --out /tmp/bench-small --branches 50 --cases 2 --contingencies 8 --window 24 --spacing 48 --repeats 20
.venv/bin/python -m tests.archive_benchmark --out /tmp/bench-archive
```

Use fresh output folders. The archive benchmark was corrected to count/hash raw values through the common reader
instead of comparing empty SQLite value tables. The same corrected measurement script was used in the before tree.
Both source and restored database were compared with canonical row digests, including every raw QDS sample.

The long dataset contains 6,073 hourly points, not a complete 8,760-hour year. The wide one has 100,000 elements and
one recorded variable per element, not the three-variable target. n-1 API requests return 404 in the main datasets
because contingencies are deliberately absent there; use the small dataset for a successful n-1 request. The area
request in these fixtures reports missing recorded active-power variables; it is not a populated-area benchmark.

Reports retain their original temporary paths for traceability; databases are not committed. Historical numbers
from the earlier interrupted session are not used as a comparable baseline for this follow-up.
