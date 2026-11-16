# Active GridLens runtime (Outage Assessment 8.2.0)

`gridlens_runtime.py` is `GridLensAssessment/outage-assessment/main_qt.py` (publisher 8.2.0,
PyQt6/PyQt5 case manager), source SHA-256 `29a41b791908145d3353e78f30310461df7b1b0216e68f51d9337598339425ea`.
Local integration changes are limited to `execute_outage_assessment`, calculation naming in
`empty_case_config` / `validate_case_config` / `CaseManagerDialog` / `obtain_case_request`, and native row
identity reading in `_read_n1_sub` via the added `contingency_row_object` helper. Calculation commands,
state restoration and engineering classification rules remain those of the source.

The dashboard handoff changes `execute_outage_assessment` in three places:

1. Optional `result_consumer` and `assessment_consumer` callbacks select dashboard mode and bypass IntReport.
2. After verified PowerFactory state restoration, the native bundle is passed to `result_consumer`, including
   `n0` and `n1_grid`. Import commits each native result independently and opens the browser on the first case.
3. The original evaluator, value release, reference application and case judgments still run. After judgment,
   `assessment_consumer` saves source findings; dashboard mode returns before report table building/publication.

The case manager requires a name for the whole calculation before starting. It is saved as optional
`analysis_name` in the backwards-compatible case configuration and in each assessment's configuration JSON.
Existing imports without a name get a readable project/run fallback in the API; names do not change native
run stamps, case IDs, calculation fingerprints or engineering criteria.

`contingency_row_object` reads the native row-axis object explicitly, supports direct objects and status/value
pairs, and resolves exact stored object indices with `GetObj`. It accepts actual `ComOutage` identities;
row numbers, case labels and name order are never treated as contingency IDs. See the local
`PythonReference_en.pdf`, ElmRes.GetObjectValue/GetValue/GetObj, and the DIgSILENT result-reading FAQ.
Both the importer and evaluator use this helper. Unresolved rows stay in `gl_unresolved_rows` with cells
and API diagnostics and mark the native result incomplete. The original n-1 evaluator rejects unresolved
identities as NOT EVALUATED. A native identity appearing twice in one study-time result is rejected explicitly.

`gridlens_dashboard.py` imports native QDS/n-1/(n-1)' results and persists original judgments, n-0 episodes,
locations and n-1 statistics separately in `gl_evaluations`. Tuple-keyed source counters use JSON
`{"entries": [{"key": [...], "value": ...}]}`; sets become sorted lists. Native PowerFactory handles and
large result value arrays are excluded. Browser assessment criteria remain separate from source judgments.

n-1-only runs use the source's own outage-window time grid, create dashboard scenario records without
inventing QDS runs, and appear in the source assessment panel with contingency extremes. QDS-dependent
profiles and before/after comparisons require actual QDS data.

The starter automatically runs setup with a Windows progress window when backend dependencies or frontend
assets are missing. Setup installs PyQt6 and matches PowerFactory's Python major/minor version so
the host can reuse the environment's PyQt/pyarrow packages. The starter
refuses a missing Qt binding before opening the manager rather than silently calculating saved cases.

The dashboard components originate from `DashB/Api-main/frontend`, commit
`6134be87e2dd3629510cbbf10d054cec68dc3a53`. The original source projects are not changed.

Native PowerFactory 2026 acceptance on Windows is still required, including Qt hosting, contingency
creation/reuse, outage windows and ElmRes timestamps.
