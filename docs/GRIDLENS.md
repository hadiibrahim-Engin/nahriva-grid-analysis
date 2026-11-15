# GridLens calculation and interactive dashboard

## Start in PowerFactory

Point an external **ComPython** in the active study case at
`powerfactory/start_assessment.py`. Use a normal ComPython; no IntReport or
report template is required. Prepare the dashboard installation with the
existing `setup.cmd` / `setup.ps1` first.

1. The starter starts the local dashboard server at once (or reuses the one
   that serves this database) and lets it come up in the background.
2. The Outage Assessment case manager of main.py opens: cases, outage
   assignments, fixed background outages, settings, network filters and
   calculation choices, exactly as in main.py.
3. Start the calculation: REF and every independent QDS case, then the
   selected n-1 and (n-1)' sweeps. Identical cases reuse native results.
4. The settings written for the run (Study Case time, 'Planned Outages'
   option, QDS period) are restored and verified. Native `ElmRes` copies stay
   in the study case. No report evaluation, no report tables, no PDF.
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

Select a kept run in the case manager's **Results** choice to import its
results again without a QDS or contingency calculation. The current settings
and the native run ID are recorded on each import; the database assessment ID
is unique per import.

Before the case manager opens, the starter checks the database folder (writable, at least
`MIN_FREE_GB` = 2 GB free) and opens the database, so a file of an earlier version is refused before
any calculation. When the dashboard is reachable from other PCs, their addresses are printed.

The starter uses `outage-assessment.config.json` and `OA_DATABASE`, `OA_HOST`,
`OA_PORT` as before. Python used by PowerFactory needs only the standard
library and its native module. The dashboard uses its existing separate
backend environment. On updating an installation, stop the old dashboard
server before starting the new backend.

## Response time

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
and sparse cell states. There is no precomputed engineering classification in
this contract. Existing dashboard widgets still apply their existing analyses
when requested; they are not a reproduction of the GridLens PDF verdicts.
New n-1 widgets can use the raw API below without adopting those analyses.

The schema extension is additive (layout 9, analysis schema 2). Existing
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
pairs, contingencies and branches in total. The workspace **n-1 review** shows both charts under one set of controls
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
