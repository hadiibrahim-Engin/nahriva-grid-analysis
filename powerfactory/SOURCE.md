# Active GridLens runtime (Outage Assessment 8.2.0)

`gridlens_runtime.py` is `GridLensAssessment/outage-assessment/main_qt.py` (publisher 8.2.0,
PyQt6/PyQt5 case manager), source SHA-256 `29a41b791908145d3353e78f30310461df7b1b0216e68f51d9337598339425ea`.
All source functions and classes except `execute_outage_assessment` are unchanged.

The dashboard integration changes that function in three places:

1. Optional `result_consumer` and `assessment_consumer` callbacks select dashboard mode and bypass IntReport.
2. After verified PowerFactory state restoration, the native bundle is passed to `result_consumer`, including
   `n0` and `n1_grid`. Import commits each native result independently and opens the browser on the first case.
3. The original evaluator, value release, reference application and case judgments still run. After judgment,
   `assessment_consumer` saves source findings; dashboard mode returns before report table building/publication.

`gridlens_dashboard.py` imports native QDS/n-1/(n-1)' results and persists original judgments, n-0 episodes,
locations and n-1 statistics separately in `gl_evaluations`. Tuple-keyed source counters use JSON
`{"entries": [{"key": [...], "value": ...}]}`; sets become sorted lists. Native PowerFactory handles and
large result value arrays are excluded. Browser assessment criteria remain separate from source judgments.

n-1-only runs use the source's own outage-window time grid, create dashboard scenario records without
inventing QDS runs, and appear in the source assessment panel with contingency extremes. QDS-dependent
profiles and before/after comparisons require actual QDS data.

Setup installs PyQt6. PowerFactory's Python must match the backend environment's major/minor version to
reuse its PyQt/pyarrow packages, or have compatible packages installed in its own environment. The starter
refuses a missing Qt binding before opening the manager rather than silently calculating saved cases.

The dashboard components originate from `DashB/Api-main/frontend`, commit
`6134be87e2dd3629510cbbf10d054cec68dc3a53`. The original source projects are not changed.

Native PowerFactory 2026 acceptance on Windows is still required, including Qt hosting, contingency
creation/reuse, outage windows and ElmRes timestamps.
