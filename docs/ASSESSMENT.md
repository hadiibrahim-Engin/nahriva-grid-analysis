# Outage assessment and evaluation across all scenarios

Everything here works **read-only** on the SQLite file. Calculation and storage of the results are
unchanged; the only addition is the LODF table `pf_lodf`.

## How the PowerFactory script calculates

`powerfactory/start_assessment.py` runs five steps and reports each one in the PowerFactory output window:

1. **Check:** project, Study Case, ComStatsim, the planned outages and the scenarios (one per planned
   outage, or the combinations in `SCENARIOS`) with their windows and equipment. Invalid names stop the
   script before anything is calculated.
2. **Reference (REF):** one QDS with **every** planned outage disabled (`outserv=1`, option *Planned
   Outages* off). REF is the same for every scenario, so it is calculated once, stored once and linked to
   every scenario. It is **saved to the database right after its calculation**, not only with the first
   scenario: its time series can be looked at (`v_samples`, `scenario` is NULL until a scenario links it)
   while the scenarios run, and also when a later step fails. A REF of an earlier, aborted assessment that no
   scenario links to is replaced.

   **When a calculation does not converge:** if ComStatsim ends with an error code (typically a load flow
   that does not converge), the time points calculated up to there are still read and saved, with the state
   *not converged* and the reason (error code, how far it got). A scenario in that state is saved and the
   assessment goes on with the next one; the dashboard shows it as a warning, and the summary table repeats
   it. A REF that did not converge is saved too, but stops the assessment: nothing can be compared with it.
   A calculation that ends normally but leaves time points without any value is saved as *incomplete*
   with the number and the first of those times. State and reason: view `v_runs` (`status`, `note`).
3. **Period check:** the outage windows are compared with the time axis REF actually covers. ComStatsim
   can declare a longer period than it simulates (e.g. *Time period* = one month around the Study Case
   time); then the script warns. A scenario whose window lies outside is skipped with a warning instead
   of being saved without values. Set the ComStatsim *Time period* so that it covers the planned outages.
4. **LODF** from PowerFactory's *Sensitivities / Distribution Factors* for the equipment of the scenarios (see below).
5. **Scenarios:** per scenario a complete QDS over the whole period with only its planned outages
   enabled and the option *Planned Outages* on. PowerFactory takes the equipment out of service inside
   the outage window and keeps it in service before and after. After saving, one line reports the
   highest loading in the window against REF, the number of elements above 100 % and the largest rise.

**Reading the output.** The output window is structured in three levels, nothing is left out:

- `====` sections: the start banner, one per step (`STEP 1/5 …`), then `SUMMARY`, and `DASHBOARD` or `ERROR` at
  the end. Step 1 lists every planned outage with equipment, window and flags, step 3 says per scenario whether
  its windows lie in the calculated period, step 4 gives the LODF status per scenario.
- `----` subsections: one per scenario (`Scenario 3/20 · NE_L1`).
- `.. Case OUTAGE · NE_L1 ....` lines: one QDS run. Below it are the enabled planned outages with their windows
  and equipment, the disabled ones by name, the ComStatsim option and period; PowerFactory's own messages and the
  `[GridLens]` progress lines follow, then the result of the scenario in one line.

The `SUMMARY` table repeats, per scenario, the time, the LODF status and the result in the outage window.

Every PowerFactory setting the script changes is restored after each step; a restoration failure stops
the script. Stopping it with *Break* keeps the scenarios saved so far.

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

The LODF comes from **PowerFactory's own tool "Sensitivities / Distribution Factors"** (`ComVstab`, LODF on),
which `powerfactory/lodf.py` executes **once before the first scenario simulation**. For every contingency of
the Contingency Analysis the tool gives, per line, the change of its flow related to the flow the outaged
equipment carried before (AC, as the Study Case calculates it). The values are signed fractions at the bus1 side
of the line (PowerFactory: 73.6 % → 0.736); the dashboard shows |LODF|. They are stored in `pf_lodf`, separate
from the result runs, together with the equipment they belong to.

**What the script sets up itself (nothing has to be prepared in the Study Case):**

1. The command *Sensitivities / Distribution Factors*: the Study Case's own, or a new one when it has none.
2. Its **own Contingency Analysis** named `Outage Assessment`, created in the Study Case (emptied and refilled
   when it exists from an earlier run). It holds **one contingency (`ComOutage`) per scenario**, named like the
   scenario and filled with the equipment of its planned outages (`ComOutage.SetObjs`); a combined outage is one
   contingency with all its equipment. The Contingency Analysis of the user is **not touched**: the command is
   pointed at ours for the run (`ComVstab.pComSimoutage`) and back at its original one afterwards.
3. It sets `lodflim` (the recording limit) to 0 for the run, because values below it are not written to
   PowerFactory's result file, switches LODF on, and puts both settings back.

What the run created stays in the Study Case so that it can be opened and inspected; the output lists it. Set
`CLEAN_UP = True` in `powerfactory/lodf.py` to delete it after the LODF is read.

**How the result is read:** the result file `…_LODF` inside `ComVstab.pResult` has one row per contingency
that converged. Its column `b:outid` is turned into the contingency by `ElmRes.GetObj`, and `ComOutage.GetObject(i)`
names the equipment it switches off. A scenario gets the row whose contingency has exactly its equipment, so
combined outages work when the Contingency Analysis has such a contingency. Scenarios with the same outages share
one calculation.

**What PowerFactory provides, and what it does not:**

- **Lines only.** The result has columns for lines (`ElmLne`). Transformers and couplers as *monitored*
  equipment have no LODF; they show "not calculated" in the matrix. (`factors4trf` does not add them.)
- **Not defined** (the dashboard shows "no LODF" with the reason, the other outages are not affected):
  - the contingency has no solution: typically a generator step-up transformer, the generator is cut off
    and PowerFactory's contingency analysis fails to converge for it (it has no row in the result file),
  - the outage switches no line, transformer or coupler (e.g. a busbar); no contingency is created for it.

The reasons are stored in `pf_lodf_undefined` and listed in the view `v_lodf_undefined`. If PowerFactory's
tool cannot be set up or fails (for example a read-only project, or an error code of the calculation) there is a
warning with PowerFactory's reason, the scenarios still run and the dashboard shows "not calculated".

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
| `GET /api/simulation/across-scenarios/{id}/profile?grid=` | loading profile of the most critical equipment (of one grid) |
| `GET /api/simulation/grids` | grids of the stored elements with their element count |
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
