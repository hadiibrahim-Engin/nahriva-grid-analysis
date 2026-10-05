# PowerFactory: Outage Assessment

The entry point is the external ComPython script `powerfactory/start_assessment.py`, the only script
that runs in PowerFactory. It calculates the scenarios one after another and saves each one at once in the
results database. When the calculation is finished it starts (or reuses) the dashboard server and opens the
dashboard in the browser; after a failure the scenarios saved so far are shown.
`SCENARIOS=None` means one scenario per eligible Planned Outage under its existing name; a list with
`name` and `outages` defines custom combinations. All references and names are checked before the
first calculation run. Database, address and port: `outage-assessment.config.json`; operation:
[DEPLOYMENT.md](DEPLOYMENT.md).

Start, end, step size, profiles and result variables come from the active `ComStatsim`.

### Result variables

The dashboard offers everything the result file (`ComStatsim.results`, an ElmRes) records, for every element in
scope; what the result file does not record cannot be shown. Choose the variables in the ComStatsim result
variables (for example `c:loading`, `m:P:bus1`, `m:Q:bus1`, `m:I:bus1` for lines).

| Variable | Stored as (dashboard Measurement) |
|---|---|
| `c:loading`, `m:loading` | `loading` in % (assessed for lines and transformers) |
| `m:u`, `m:u1` | `voltage` in p.u. (assessed for busbars) |
| `m:P:bus1`, `m:P:bushv` | `active_power` |
| `m:Q:bus1`, `m:Q:bushv` | `reactive_power` |
| `m:S:bus1`, `m:S:bushv` | `apparent_power` |
| `m:I:bus1`, `m:I:bushv` | `current` |
| any other variable, e.g. `m:P:bus2`, `m:phiu` | its name with `:` replaced by `_` (`m_P_bus2`, `m_phiu`) |

Of the terminals (`ElmTerm`) only **busbars** are read: usage *Busbar* (`iUsage = 0`). Junction nodes and internal
nodes are left out of everything (voltage and every other variable); the output says how many. A terminal whose
usage cannot be read counts as a busbar. `BUSBARS_ONLY = False` in `gridlens_engine.py` reads every terminal.

Calculation parameters (`b:...`, such as the time) are not stored. After the reference calculation the
PowerFactory output lists what the result file records per class and variable and how each is stored, and warns
when lines, transformers or busbars have no loading or voltage to assess. Only lines and transformers (loading)
and busbars (voltage) are assessed; all other quantities are time series only. The database grows with every
variable: `READ_ALL_VARIABLES = False` in `gridlens_engine.py` stores only loading and voltage; the limit
`MAX_RESULT_CELLS` stops a result file that is too large with a clear message.

## Applying the outages

As in GridLens, `ComStatsim.iopt_maint=0` is used for REF and `1` for OUTAGE. PowerFactory honours
the own `starttime` / `endtime` windows of the `IntPlannedout` objects. Selected outages temporarily
get `outserv=0`, the others `outserv=1`. Entries that were ignored before can be part of a scenario
explicitly. There are no invented apply / reset calls.

Outage flags, `iopt_maint`, `SetTime.cDate` / `cTime` and the original `ComStatsim.results` binding are
captured, restored and verified. The calculation uses copied ElmRes objects with the existing variable
selection. Only after their removal are the scenario name and both complete result runs saved in one
SQLite transaction. Failed calculations or an unverified restoration create no saved scenario.

`analysis_worker.py` contains this processing and can still process a single queued job.
`start_assessment.py` creates such jobs itself; the dashboard only visualises results and has no web
form for creating jobs.

## Data and real acceptance

Native results contain loading of lines and transformers and voltages from the configured QDS
variables. The database export stores all rows up to the explicit GridLens result limit, without thinning
to 200 report points. REF and OUTAGE need identical time axes. Unclear or out-of-period time axes are
rejected; no time shift is invented.

The GridLens check whether ElmRes timestamps mark interval ends remains part of the native Windows
acceptance. A real PowerFactory 2026 run has not been executed on the Mac.
[Flow diagrams and error paths](../BIG_PICTURE.md).
