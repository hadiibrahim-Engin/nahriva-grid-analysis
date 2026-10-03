# Outage assessment and evaluation across all scenarios

Everything here works **read-only** on the SQLite file. Calculation and storage of the results are
unchanged; the only addition is the LODF table `pf_lodf`.

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

Heavy sections load only when they come close to the viewport (see "Large databases").
Explanations are off by default; open them per card with **i** or for everything with
**Explanations**.

## Adding charts

**Add chart** offers the charts that make sense for the two exported signals, loading (L) and
voltage (U):

- **Scenario evaluation** (no selected signals needed): highest loading, overload duration, change of
  loading, LODF and change, **voltage per busbar** and **voltage change (ΔU)**.
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

`powerfactory/lodf.py` calculates DC load flows (`ComLdf`, `iopt_net=2`) **before the first
simulation**: per scenario its outage objects are switched off together and
`LODF = ΔP_equipment / ΣP_outaged,before` is determined (normalised with magnitudes for several
outages; |LODF| is shown). The values are stored in `pf_lodf`, separate from the result runs. If the
load flow fails there is a warning, the scenarios still run, and the dashboard shows "not calculated".
To verify on the PowerFactory PC: the variables `m:P:bus1` / `m:P:bushv` and the assignment of outage
objects to equipment.

## Large databases

The server reads only what is asked for, and the frontend asks only for what becomes visible.

1. `GET /across-scenarios/index` returns scenarios and outages **without reading samples**.
2. The frontend then fetches `GET /across-scenarios/{id}/cells` scenario by scenario (3 at a time). The
   scenarios appear in a fixed order, the codes S01, S02 … stay stable, and the first verdicts are
   there before the end. A progress bar shows the state.
3. Per scenario two grouped SQL passes over the loading series (REF and OUTAGE) plus a few for voltage
   are enough. The result is cached in the server; saved scenarios never change, so a refresh only
   loads new scenarios.
4. Sections below the assessment (profile, details, voltage, matrix, charts, radar, table) mount only
   when they come close to the viewport or the navigation jumps to them. Only then are their code and
   data loaded. `GET .../{id}/profile` reduces a time series to at most 300 points (maximum per
   bucket, peaks are kept).
5. Matrix and table first show the most conspicuous equipment and page on.

Not measured: behaviour with millions of rows per run on the real PC. The split is prepared for it;
please check timings there.

## API (read-only)

| Path | Content |
|---|---|
| `GET /api/simulation/across-scenarios/index` | scenarios, outages, period |
| `GET /api/simulation/across-scenarios/{id}/cells` | reduced values of one scenario (cached) |
| `GET /api/simulation/across-scenarios/{id}/profile` | loading profile of the most critical equipment |
| `GET /api/simulation/across-scenarios` | everything together (index plus all scenarios) |
| `GET /api/simulation/outage-management` | catalog, jobs and saved scenarios |
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
