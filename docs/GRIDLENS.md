# GridLens calculation and interactive dashboard

## Start in PowerFactory

Point an external **ComPython** in the active study case at
`powerfactory/start_assessment.py`. Use a normal ComPython; no IntReport or
report template is required. On Windows, the starter prepares missing backend packages and frontend
builds automatically, with a separate progress window before loading Qt. Manual `setup.cmd` / `setup.ps1`
is optional. PowerFactory needs Python 3.12 or newer.

1. The starter starts the local dashboard server at once (or reuses the one
   that serves this database) and lets it come up in the background.
2. The Outage Assessment 8.2 Qt case manager opens: cases, outage
   assignments, fixed background outages, settings, network filters and
   calculation choices, exactly as in main_qt.py.
3. Start the calculation: REF and every independent QDS case, then the
   selected n-1 and (n-1)' sweeps. Identical cases reuse native results.
4. The settings written for the run (Study Case time, 'Planned Outages'
   option, QDS period) are restored and verified. Native `ElmRes` copies stay
   in the study case. No report tables or PDF are published.
5. The bridge reads the copies into the local results database, REF first,
   then case by case, each in its own transaction. As soon as the first
   planning case is stored the browser opens; the dashboard lists the other
   cases by itself as they arrive (progress banner). Each case is stored with
   its dashboard summary (`pf_scenario_cells`), so the evaluation appears at
   once instead of reducing every value on first view.
6. n-1 sweeps follow; while their cells are read the bridge writes the n-1
   summaries (`gl_n1_hourly`, `gl_n1_columns`: per column and study time the worst value and contingency, per
   column the extremes, limits and violating times) used by the asset view and the n-1 charts.

A cancelled case manager calculates nothing, opens no browser and stops the
server it started. A failure keeps the cases already stored; the cases that
are missing get status `IMPORT FAILED` with the reason, and the native results
stay in PowerFactory for a new import.

After the native import, the original 8.2 evaluation runs on the kept results. Source n-0 verdicts,
locations and episodes, and n-1 summaries/statistics are stored in `gl_evaluations` and exposed by the
assessment API. `?summary=true` omits the large n-1 statistics and lists the first 100 n-0 episodes
per case; the panel links to a complete JSON download. The PowerFactory assessment panel polls while evaluation is pending, then shows these
findings separately from browser-based criteria. A source evaluation failure keeps imported native results
and is shown explicitly; interrupted evaluations are marked failed when the next import recovers the file.
Assessment status changes from `importing` to `evaluating` to `complete` (or `evaluation_failed`).

Untick n-0 for n-1 only. No ComStatsim is required: the source samples outage windows using the n-1 time
step in Settings. These cases appear in the source panel with paginated contingency extremes. QDS widgets
remain unavailable without QDS measurements; no baseline or QDS values are synthesized.

Select a kept run in the case manager's **Results** choice to import its
results again without a QDS or contingency calculation. The current settings
and the native run ID are recorded on each import; the database assessment ID
is unique per import.

Before the case manager opens, the starter checks the database folder (writable, at least
`MIN_FREE_GB` = 2 GB free) and opens the database, so a file of an earlier version is refused before
any calculation. When the dashboard is reachable from other PCs, their addresses are printed.

The starter uses `outage-assessment.config.json` and `OA_DATABASE`, `OA_HOST`,
`OA_PORT` as before. Python used by PowerFactory needs its native module, PyQt6/PyQt5 and pyarrow. Setup installs PyQt6
in the backend environment; reuse requires matching Python major/minor versions. The dashboard uses its existing separate
backend environment. On updating an installation, stop the old dashboard
server before starting the new backend.

## Historical response time (before the current Parquet import)

Current measurements and limits: [PERFORMANCE.md](PERFORMANCE.md).

Measured on this Mac with a synthetic year (660 series × 8,760 h, REF + 5
cases = 34.7 million values): the first case is visible with its complete
evaluation 7.5 s after PowerFactory finished, all cases after 25 s; the
dashboard answers the evaluation of all five cases in 11 ms (before: about
1.2 s per case on first view). A sweep of 13.4 million n-1 cells (168 study
times × 200 contingencies × 400 columns) answered the former n-1 Gantt chart in 21 ms
(5 ms cached). About 70 % of the import is SQLite inserting one row per value;
the PowerFactory reads use one `GetColumnValues` call per column, as main.py.

## Stored quantities

| PowerFactory variable | Stored as (dashboard Measurement) |
|---|---|
| `c:loading`, `m:loading` | `loading` in % (assessed for lines and transformers) |
| `m:u`, `m:u1` | `voltage` in p.u. (assessed for busbars) |
| `m:P:bus1`, `m:P:bushv` | `active_power` |
| `m:Q:bus1`, `m:Q:bushv` | `reactive_power` |
| `m:S:bus1`, `m:S:bushv` | `apparent_power` |
| `m:I:bus1`, `m:I:bushv` | `current` |
| any other variable, e.g. `m:P:bus2` | its name with `:` replaced by `_` (`m_P_bus2`) |

The grid of an element is the `ElmNet` folder in its path (`...\D7 Grid.ElmNet\Line 1.ElmLne` → `D7 Grid`);
the dashboard's Grid dropdown filters by it. The network scope of the case manager decides which grids are read.

## Preserved presentation and data

The React windows, styling, navigation, chart picker and existing widgets are
unchanged. QDS results use the existing `analysis_*` tables and REF/OUTAGE
scenario links, so existing time-series and scenario widgets keep working.
All recorded, in-scope numeric signals are offered, including P/Q/S/I where
recorded; the bridge does not add variables or change the QDS recording setup.
It does not restrict results to report plot points or a report top-N list.

The additional `gl_*` tables retain assessment/case definitions, settings,
native names and full paths, actual timestamps, native columns, contingencies
and sparse cell states. Raw native results remain separate from source classification in `gl_evaluations`. Existing dashboard widgets still apply their existing analyses
when requested; they are not a reproduction of the GridLens PDF verdicts.
New n-1 widgets can use the raw API below without adopting those analyses.

The schema extension is additive (layout 17, analysis schema 2, native result contract 4). Existing
compatible result files are retained and get the new tables when opened.

## Widget API

The read-only prefix is `/api/simulation/gridlens`:

| GET | Data |
|---|---|
| `/assessments` | Imported assessments, native run ID and settings |
| `/assessments/{id}` | Assessment, cases, definitions, result references and failures |
| `/assessments/{id}/elements?offset=0&limit=1000` | Master data of the analysis: internal key, name, class, path, grid, nominal kV, mRID (NULL until verified) |
| `/results/{id}` | Source object, kind, state, recording limits and requested/actual study times |
| `/results/{id}/columns?offset=0&limit=200` | Monitored objects, stable IDs, PF variables and units |
| `/results/{id}/contingencies?offset=0&limit=100` | Native fault identities and outaged equipment |
| `/results/{id}/times?offset=0&limit=1000` | Actual timestamps, in epoch seconds UTC |
| `/results/{id}/series?column_id=0&contingency_id=...` | Raw values and quality states for one object/quantity/fault |


`series` accepts `start`, `end` (exclusive), `offset` and `limit` (at most
5,000). All pages contain original samples; pagination is not downsampling.
For QDS, omit `contingency_id`. The TypeScript client is
`frontend/src/api/gridlens.ts`; requests support cancellation with AbortSignal.

Contingency series distinguish:

- `value`: finite measured number, including a real zero;
- `not_recorded`, code 3: no measured value; only known to be inside the native
  recording limits, which are supplied as metadata;
- `read_error` / `invalid`: unreadable or invalid native cell;
- `missing_row`: no result row for that fault at the time;
- `missing_column`: the monitored variable was not recorded at that time.

A missing study time is listed in `metadata.missing_times`. A missing row can
be caused by a planned outage already switching off the fault equipment;
raw data does not infer a verdict from its absence. Case windows, equipment
paths and contingency equipment remain available to widgets for that purpose.
The verified interface does not expose a reliable post-fault phase identity;
`phase` is explicitly null. Do not compare differently configured phases.
QDS bulk reads expose values without per-cell return codes; invalid/missing
values remain null and are marked `invalid_or_missing`.

Absolute native timestamps are retained. A relative QDS axis is accepted only
when it starts at zero and the configured QDS start supplies its origin;
this is recorded as `relative_to_qds_start`. Ambiguous, descending or duplicate
axes are refused. No interpolation or invented samples are used.

## n-1 pairs (contingency → overloaded branch)

`GET /api/simulation/scenarios/{id}/n1-pairs?kind=(n-1)'|n-1&start&end&limit&grid&kv` gives per pair of contingency and
branch the highest loading after the contingency (from the recorded n-1 cells, above the recording limit), the time
of it, the loading before the contingency at that time (QDS of the planning case for (n-1)', of REF for n-1, read
from wherever the run keeps its values) and the hours above the branch's limit, worst first, with the number of
pairs, contingencies and branches in total. The section **n-1 review** loads both charts after **Load n-1 results**, under one set of controls
(scenario, during the maintenance or without, top 10/25/50); *n-1: before → after per branch* and *n-1: contingency →
overloaded branches (Sankey)* can also be added one by one in **Add chart**. A contingency that has no load-flow solution leaves no row
in the sweep and therefore no pair. `grid` and `kv` (the header's filters) keep the pairs whose overloaded branch
lies in that grid or at that nominal voltage; `limit` up to 100,000 ("All" in the charts).

## Analyses, states and time series

- `GET /api/simulation/analyses` lists every import with status and result kinds and names the default (the newest
  with a scenario). `across-scenarios/index`, `across-scenarios` and `facilities` take `?analysis=<id>`; without it
  they show the default. Scenarios of different imports are never mixed.
- `GET /api/simulation/states` is the versioned catalogue of every state the API reports.
- `/timeseries/raw/...` keeps a time without a valid value as `{"value": null, "state": "invalid_or_missing"}`
  (a gap, never 0) and counts them in `meta.missing_points`. `/timeseries/aggregate/...` reduces by `MINMAX` by
  default: per bucket the stored samples with the lowest and the highest value, at their own times, so peaks
  survive and nothing is invented; `AVG`, `MIN`, `MAX`, `SUM` remain selectable.

## Extension points for further calculation types

The raw contract is not tied to QDS. A further calculation type adds result kinds, not tables:

| Type | `gl_results.kind` | Time (`gl_times`) | Case dimension (`gl_contingencies`) |
|---|---|---|---|
| QDS | `QDS` | every QDS step | – |
| n-1 / (n-1)' | `n-1`, `(n-1)'` | study times | contingencies |
| Load flow (planned) | e.g. `LF` | one row per operating point | – |
| Short circuit (planned) | e.g. `SC` | calculation time | one row per fault (location, type, method in `equipment`/metadata) |

Values go to `gl_values` with their state; `gl_assessments.calculation_types` lists the kinds of an analysis. Which
PowerFactory commands and variables deliver load flow and short circuit is not verified yet.

## Runtime and acceptance

`gridlens_runtime.py` is main.py 8.1.0 of GridLensAssessment/outage-assessment
(see powerfactory/SOURCE.md). Its calculation, case-manager and restoration
definitions are main.py's own. main.py 8.1 sets the QDS period of a run from the
planned outages; the bridge anchors relative time axes on that run period. Its optional result-consumer hook hands off after verified
restoration, before report evaluation. `gridlens_dashboard.py` supplies that
consumer. No LODF is calculated.

Tests cover real orchestration against native API stand-ins, QDS sample
completeness, n-1/(n-1)' time grids, state restoration, kept/reused runs, sparse
codes, rollback and the browser handoff. A real PowerFactory 2026 acceptance
on Windows remains necessary for the installed API, native GUI and model.

## Continuous navigation and chart interaction

The dashboard is one scrolling page. The left rail jumps to Assessment, Scenarios, Network, Assets, n-1 review,
Compare and Charts, and highlights the current section while scrolling. Deferred views keep their anchors; a jump
stays aligned while content above it finishes loading. Normal scroll, touch and keyboard input release that alignment.
The URL's `view` still restores a section, and `scenario` still restores the selected planning case.

The loading profile (including S03 Maintenance Line 16 - 17) zooms along time and loading with sliders or Ctrl +
mouse wheel; dragging pans and **Reset zoom** restores both axes. Unmodified wheel input scrolls the dashboard.
The profile keeps the delivered samples, gaps, reference lines and outage windows.

Neither visiting n-1 review nor **Expand** starts n-1-pairs requests. Only **Load n-1 results** mounts those charts;
**Hide n-1 results** closes them. The asset view separately offers **Show n-1 extremes** for its existing summary.


## Calculation names and contingency import diagnostics

In the case manager, **Calculation name** names the complete run containing its planning cases. Enter it
before Start calculation. It is saved with the case configuration, shown in the dashboard analysis picker,
source assessment heading and comparison search, and retained in archives. Individual C1/C2 case identifiers
remain local to that named calculation. Earlier imports display project and native run stamp as a fallback.

When reimporting kept results through **Results**, enter the desired calculation name and select the old
run stamp: this creates a new named import without repeating the PowerFactory calculation.

For contingency results, the importer reads the row-axis object or resolves its stored index using `GetObj`.
DIgSILENT explains the index/object distinction in its [ElmRes result-reading FAQ](https://www.digsilent.net/en/faq-reader-powerfactory/how-can-i-read-data-from-a-result-file-elmres-via-script.html).
If no native contingency identity can be resolved, the import keeps the row's raw cells and diagnostic calls
in `gl_unresolved_rows`, marks the result **incomplete**, and shows the reason in the source assessment panel.
It does not guess an identity or turn missing coverage into zero or a successful n-1 verdict. The original
n-1 source evaluator reports **NOT EVALUATED** in that case. Other imported results remain available.

`GET /api/simulation/gridlens/results/{id}/unresolved-rows?offset=0&limit=100` returns paginated raw rows,
including study time, native row index, diagnostic API calls and raw column values/codes. The panel links to
this endpoint; the full archive preserves all rows. To recover from the former Step 6 import error, choose
the kept run in **Results** and import it again using the updated script. No recalculation is required.

After updating an existing installation, stop the old dashboard server once before starting the new backend.
The starter rebuilds a frontend whose source files are newer than its build automatically.


## Finding n-1 results and running a read-only diagnostic

Select the intended calculation in **Analysis**. In **PowerFactory assessment**, each case lists its stored
n-1 and (n-1)' results with expanded extrema tables. Overload-pair charts use the native sweep index
(`GET /api/simulation/gridlens/sweeps?analysis=<id>`) independently of QDS. Only imported sweep types are
enabled: a calculation containing only n-1 selects n-1 automatically. The pair charts show overloads only;
an empty pair chart does not mean that no results were imported. Sparse code-3 cells have no numeric value
to plot; the extrema table and source import status show what is actually available.

Storage: `gl_results` links result kind/status to calculation and case, `gl_contingencies` identifies faults,
`gl_times` records study times, `gl_columns` describes recorded quantities, and `gl_values` holds sparse raw
cells. `gl_n1_columns` / `gl_n1_hourly` hold extrema and violation summaries. Unresolved native row identities
are retained separately in `gl_unresolved_rows`.

For a real PowerFactory check, create another external **ComPython** pointing to
`powerfactory/check_n1_results.py`. Activate the affected study case and execute it after the calculation.
It reads kept n-1 results and the configured SQLite database; it never calls Execute, changes model settings,
imports results or installs packages. If the dashboard uses another database, set `DATABASE_PATH` at the top
of the diagnostic script to that exact file. Otherwise the normal configuration / OA_DATABASE setting applies.

The output window prints findings and the local report path:
`.tools/n1-diagnostic-<timestamp>.json`. The report includes Python/runtime context, bounded samples of native
API return values, contingency identity resolution, calculation IDs, import statuses and summary counts.
Its samples cover up to 10 result objects, 3 study-time subresults per object, 8 rows and 3 columns; this is a
diagnostic sample, not proof that every cell of a large sweep is valid. It contains model/equipment names and
paths and remains on the PC. A missing database is reported without creating or migrating one.


## Database contents overview

Use **Database contents** in the dashboard header to inspect the open database before choosing a calculation.
The dialog lists named calculations, creation date, project/study case, expandable case names and statuses,
and separate n-0/QDS, n-1 and (n-1)' result counts. Incomplete, failed and uncalculated results are distinguished;
reference result sets are included in result counts. Earlier cases without a calculation assignment form their
own group and do not increase the named-calculation count. The SQLite file size excludes external result files.

Search names/cases/statuses, then choose **View calculation** to load only that calculation through the existing
analysis selection. **Refresh contents** updates the metadata. Opening or exporting another dataset remains
available in the other tabs where database switching is enabled; the contents overview is also available in
read-only/network mode.

`GET /api/simulation/database/contents` reads calculation, case and result headers inside a consistent SQLite
read transaction. It does not query raw measurement cells, hourly values or prepared scenario payloads. This
keeps the initial database overview independent of the number of recorded time-series samples.
