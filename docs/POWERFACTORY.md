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

The dashboard can only show what the result file (`ComStatsim.results`, an ElmRes) records. The script reads:

| Class | Variable | Shown as |
|---|---|---|
| ElmLne | `c:loading` (else `m:loading`) | loading in % (assessed) |
| ElmTr2, ElmTr3 | `c:loading` (else `m:loading`) | loading in % (assessed) |
| ElmTerm | `m:u` (else `m:u1`) | voltage in p.u. (assessed) |
| ElmLne | `m:P:bus1`, `m:Q:bus1` | active / reactive power (dashboard time series, not assessed) |
| ElmTr2, ElmTr3 | `m:P:bushv`, `m:Q:bushv` | active / reactive power, HV side (dashboard time series, not assessed) |

Everything else in the result file is not read. After the reference calculation the PowerFactory output lists
what the result file records per class and variable and what is used, and warns when lines, transformers,
busbars or power are missing, with the variable to add. Power about doubles the size of the database (two more series per branch);
`READ_POWER = False` in `gridlens_engine.py` reads loading and voltage only.

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
