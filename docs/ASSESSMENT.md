# Outage assessment and evaluation across all scenarios

## Views added in phase 3

- **Network at a time** (follows the chosen scenario): per time the worst value of the scenario against REF and
  the number of elements beyond their limit, the most critical times, and for one time every element with REF,
  scenario value and change (CSV) plus the restore package of that time.
- **Asset**: one element across every scenario of the analysis, its n-1 extremes per case and its course against
  REF (CSV).
- **Restore package**: a JSON hand-over for PowerFactory (analysis, run, case, planned and background outages with
  paths and windows, settings, native result objects, optional time). Its `limitations` list what is not recorded;
  rebuilding is PowerFactory's job.
- Header: **Voltage level** filter (nominal kV of the master data), **Copy link** (pins analysis, grid and level as
  `?analysis=…&grid=…&kv=…`). Every chart offers a PNG download; the detail table, the time point and the asset view
  a CSV download.

## Limits, large analyses, bookmarks (phase 3b)

- **Limits** (header): the thresholds of this evaluation (loading bands, voltage band and margin, thermal reserve,
  aggravation) can be changed for this browser; saving reloads the dashboard so every band, legend and verdict uses
  them. Defaults stay in `frontend/src/config/`. The n-1 Gantt and the counts of the time-point view use the limits set
  for the run in PowerFactory instead.
- **Large analyses** (more than 5,000 elements per scenario): only the relevant elements are listed, with a note
  saying how many of how many; verdicts and key figures are complete.
- **Equipment field**: up to 2,000 elements it is loaded whole; a larger run is searched on the server as you type.
- **Bookmarks** (header): named views (analysis pinned, grid, voltage level, scenario), each a link; the list can be
  saved to a file and read back. The address bar always holds the current view.
- **Time course**: longer than 2,000 times it comes as the worst value per interval, at the real time of the worst
  value; the critical times are always ranked at full resolution.

## Where the results come from

The PowerFactory script runs main.py's case manager and calculation and imports the kept native results
case by case; see [GRIDLENS.md](GRIDLENS.md). Everything below works **read-only** on that database, on the
scenarios of **one analysis** (the *Analysis* field in the header; default: the newest import). Each scenario is
evaluated with the outage windows and equipment of its own import.

## Reading order

The navigation and the page follow the path of an assessment:

| Section | Question |
|---|---|
| Key figures | How many scenarios are permissible, conditional, not permissible? Where are the extremes? |
| Assessment | Verdict per scenario with reasons, outage, timeline, distribution |
| Profile, scenario details | When and for how long is the chosen scenario critical? |
| Voltage | Which busbar leaves the band? |
| Matrix | Which equipment is loaded how much in which scenario? |
| Charts, radar | Comparison across all scenarios (loading, duration, change, LODF) |
| Detail table | Every number, sortable |

The **Grid** dropdown in the filter bar restricts the whole page to one PowerFactory grid (ElmNet),
e.g. *D7 Grid*: the equipment dropdown, key figures, verdicts, profile, voltage, matrix, charts, radar,
detail table and the added scenario charts. The grid of an element comes from its stored PowerFactory
path, so it works for databases written before the filter existed. The choice is remembered per browser.

Heavy sections load only when they come close to the viewport (see "Large databases").
Explanations are off by default; open them per card with **i** or for everything with
**Explanations**.

## Adding charts

**Add chart** offers the charts that make sense for the exported signals: loading (L), voltage (U), and where the
result file records them active power (P), reactive power (Q) and current (I):

- **Scenario evaluation** (no selected signals needed): highest loading, overload duration, change of
  loading, **LODF per line of one outage** (zoomable), LODF and change (zoomable), **voltage per busbar** and **voltage change (ΔU)**.
- **Time series, distribution, limits:** time series overlay, aggregated trend, rolling mean, anomaly
  score, histogram, boxplot, duration curve, threshold exceedance, multi-level threshold lines,
  voltage compliance.
- **Correlation:** correlation scatter (Pearson, Spearman, Kendall), colour-coded scatter, 3D scatter
  and correlation matrix.

Options of the scenario evaluation charts:

- **Selection:** *Automatic* shows the most conspicuous N (5 to 30). *Selected* shows exactly the chosen
  equipment (or busbars) from a searchable list, one group per equipment item with one bar per
  scenario. The **scenarios** can be narrowed as well (codes S01, S02 … stay those of the full list).
  The type (all, lines, transformers) filters line and transformer charts.
- **Voltage:** bars start at the nominal voltage 1.000 p.u. and go left and right, the band 0.90 and
  1.10 is drawn; ΔU is the change against REF on the side closer to the band.
- The cards share their data with the summary, load nothing twice, follow new scenarios by themselves
  and are saved with the view.

All templates are registered in `frontend/src/components/charts/chartTemplates.ts`.

## Definitions

- **Scenario value:** maximum OUTAGE loading in the outage window of the scenario.
- **Base:** maximum REF loading over the whole period.
- **Δ loading:** scenario value minus REF in the same window, in percentage points (pp).
- **Overload rate:** time above 100 % in the worst scenario, relative to the **simulation period**
  (not to the number of scenarios).
- **Excess:** `max(loading − 100 %, 0)` in pp; sum, maximum and mean are in the table.
- **Cause** against REF in the same window: *caused* (REF ≤ 100 %, above with the outage),
  *aggravated* (already above, at least 2 pp higher), *pre-existing* (unchanged).
- Equipment switched off in a scenario is not assessed there ("OFF").

## Assessment

All equipment is assessed: lines and transformers by loading, busbars by voltage.

| Verdict | Criterion |
|---|---|
| Not permissible | overload or voltage violation caused or aggravated by the outage |
| Conditionally permissible | no new violation, but pre-existing load > 100 %, reserve < 5 pp, warning range ≥ 80 % newly reached or voltage closer than 0.02 p.u. to a limit |
| Permissible | otherwise, with highest loading and reserve |

The verdict is a decision aid according to these criteria, not an approval. The type filter
(All / Lines / Transformers) only narrows matrix, charts, radar and table.

**Voltage:** the band is central, **0.90 to 1.10 p.u.**, and applies to all results stored in p.u.
Results in kV are judged against the limits stored with them; without limits no violation is derived.

## LODF

The dashboard shows line outage distribution factors (|LODF|, notable from 0.3) when the table `pf_lodf` holds
them, and the reason per scenario from `pf_lodf_undefined`. The current PowerFactory workflow calculates no LODF,
so both tables stay empty and the LODF parts of the dashboard show "not calculated".

## Large databases

The server reads only what is asked for, and the frontend asks only for what becomes visible.

Series and analyses (`/timeseries/...`, `/analytics/...`) are handled as epoch seconds and numbers, not as one datetime and
dictionary per value, and are sent without a second encoding pass: a year at 15 minutes (35 040 values) takes about
0.1 s per series, the duration curve, box plot and overload analysis 0.02-0.03 s.

1. `GET /across-scenarios/index` returns scenarios and outages **without reading samples**.
2. The frontend then fetches `GET /across-scenarios/cells?ids=…` in growing groups (3, 6, 12, then 24 scenarios,
   two groups at a time): the first verdicts appear quickly, and the summary is evaluated once per group instead
   of once per scenario. The scenarios appear in a fixed order, the codes S01, S02 … stay stable, and the first
   verdicts are there before the end. A progress bar shows the state.
3. Per scenario two grouped SQL passes over the loading series (REF and OUTAGE) plus a few for voltage
   are enough. The result is cached in the server; saved scenarios never change, so a refresh only
   loads new scenarios.
4. Sections below the assessment (profile, details, voltage, matrix, charts, radar, table) mount only
   when they come close to the viewport or the navigation jumps to them. Only then are their code and
   data loaded. `GET .../{id}/profile` reduces a time series to at most 300 points (maximum per
   bucket, peaks are kept).
5. Matrix and table first show the most conspicuous equipment and page on. Above 60 rows (all equipment of a large
   grid, many busbars, a long detail table) only the rows around the visible part are rendered; the browser's page
   search then finds only those rows, the table filters find all of them.
6. Profiles are cached in the server as well; choosing a scenario again reads nothing. The status of the PowerFactory
   script (`/outage-management`, asked every 3 s) carries an ETag: unchanged, the server answers with an empty 304.

Not measured: behaviour with millions of rows per run on the real PC. The split is prepared for it;
please check timings there.

## API (read-only)

| Path | Content |
|---|---|
| `GET /api/simulation/analyses` | every analysis (import) of the file, newest first, and the default one |
| `GET /api/simulation/states` | the versioned catalogue of result states |
| `GET /api/simulation/voltage-levels?analysis=` | nominal voltages of the analysis with their element count |
| `GET /api/simulation/scenarios/{id}/times?points=2000` | per time (or per interval, when longer) the extremes and violation counts of REF and the scenario; the most critical times |
| `GET /api/simulation/facilities/{run}/components?q=&grid=&kv=&limit=` | elements of a run, filtered and limited; `X-Total-Count` gives all matches |
| `GET /api/simulation/scenarios/{id}/snapshot?t=&metric=&limit=&offset=&grid=&kv=` | every element at one time against REF, most critical first, in pages |
| `GET /api/simulation/scenarios/{id}/restore-package?t=` | the facts PowerFactory needs to rebuild the scenario, with their limitations |
| `GET /api/simulation/assets/{element}?analysis=` | one element across the scenarios: master data, key figures, n-1 per case |
| `GET /api/simulation/across-scenarios/index?analysis=` | scenarios of one analysis (default: the newest), outages, period |
| `GET /api/simulation/across-scenarios/cells?ids=a&ids=b&over=…&warning=&band_lower=&band_upper=&margin=` | reduced values of up to 50 scenarios in one answer (`null` for an unknown one); a large scenario lists its relevant elements (`listing`) |
| `GET /api/simulation/across-scenarios/{id}/cells` | reduced values of one scenario (cached) |
| `GET /api/simulation/across-scenarios/{id}/profile?grid=` | loading profile of the most critical equipment (of one grid) |
| `GET /api/simulation/grids` | grids of the stored elements with their element count |
| `GET /api/simulation/across-scenarios` | everything together (index plus all scenarios) |
| `GET /api/simulation/outage-management` | catalog, jobs, saved scenarios and the script's progress (ETag, 304 when unchanged) |
| `GET /api/simulation/facilities`, `.../components`, `.../timeseries/...`, `.../analytics/...` | series and analyses for the signal charts |

The API has no write endpoints except switching the database (`POST /api/simulation/database`, only
while the server is not exposed to the network).

## Where to customise

| What | File |
|---|---|
| Loading bands, thresholds for patterns, weights of conspicuousness | `frontend/src/config/loadingBands.ts` |
| Assessment criteria, voltage band, reserve | `frontend/src/config/assessment.ts` |
| Assessment logic | `frontend/src/util/outageAssessment.ts` |
| Loading in parts | `frontend/src/hooks/useAcrossData.ts`, `frontend/src/util/acrossLoad.ts` |
| Aggregation, cache | `backend/app/simulation/across.py` |
