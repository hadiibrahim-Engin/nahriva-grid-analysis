# Outage Assessment — Big Picture

## 1. Purpose and components

A user runs Outage Assessment locally on their PowerFactory PC. The ComPython script calculates outage
scenarios and stores their results in SQLite. The dashboard shows these results as a summary with an
assessment per scenario and, on request, with signal charts. There is no login, no user management, no
footer and no date filter for the plots. Nothing needs administrator rights or an extra network port.

```mermaid
flowchart LR
    User[User in PowerFactory] --> Entry[start_assessment.py]
    Entry --> Plan[scenario_plan: check names and outages]
    Plan --> Batch[run_assessment: scenarios one after another]
    Batch --> Worker[analysis_worker.py]
    Worker --> Engine[gridlens_engine.py]
    Engine --> PF[ComStatsim and ElmRes]
    PF --> Worker
    Worker --> Store[ScenarioStore]
    Store --> DB[(Local SQLite file)]
    Batch --> Launcher[dashboard_launcher.py: after the last scenario]
    Launcher --> Server[Local FastAPI server]
    Server --> DB
    Server --> Browser[Outage Assessment in the browser]
    Browser --> Charts[Charts]
```

| File | Responsibility |
|---|---|
| `powerfactory/start_assessment.py` | database folder / name, scenario definitions, native calculation and dashboard start |
| `powerfactory/analysis_worker.py` | read the PF context, activate outages, run REF/OUTAGE, restore state, serialise complete series |
| `powerfactory/gridlens_engine.py` | taken-over GridLens helpers for native objects, QDS, ElmRes and restoration |
| `powerfactory/lodf.py` | LODF from DC load flows before the first simulation |
| `backend/app/simulation/store.py` | shared SQLite contract of PF and web app; jobs and atomic scenario import |
| `backend/app/simulation/across.py` | read-only aggregation: index, values per scenario (cached), profile |
| `backend/app/simulation/routes.py`, `data.py` | HTTP API on SQLite: series and analyses |
| `backend/app/main.py` | HTTP process, readiness, API and static frontend |
| `scripts/dashboard_launcher.py` | start a separate HTTP process for exactly the given database and open the browser |
| `scripts/serve.py`, `appconfig.py` | permanent server and shared configuration |
| `setup.ps1`, `setup.cmd` | one script from A to Z: Python, backend, Node, frontend build, configuration, self-test (no administrator rights) |
| `frontend/src/pages/DashboardPage.tsx` | selection of scenario / equipment / measurement and complete result series |
| `frontend/src/components/across/` | summary: key figures, assessment, profile, voltage, matrix, charts, radar, table, details |
| `frontend/src/hooks/useAcrossData.ts`, `util/acrossLoad.ts` | loading in parts: index first, then scenario by scenario |
| `frontend/src/util/outageAssessment.ts`, `config/assessment.ts` | cause, voltage band and verdict with criteria |
| `frontend/src/config/loadingBands.ts` | central loading bands and thresholds |
| `docs/ASSESSMENT.md` | definitions, criteria, API and customisation of the evaluation |
| `start-dashboard.command` | start the dashboard for an existing results database on the Mac |
| `backend/tests/qds_fixture.py` | synthetic test database, tests only (not in the package) |

## 2. Native execution in PowerFactory

`DATABASE_DIRECTORY` and `DATABASE_NAME` are configured in `start_assessment.py`. `SCENARIOS=None`
means: every eligible Planned Outage object with an overlapping QDS window forms one scenario under its
existing name. Outages that were ignored originally are activated explicitly for their own run. A
scenario can alternatively combine several outages under a custom name. With ambiguous object names,
full PF paths are used.

Start, end, step size, profiles and result variables are configured in the active `ComStatsim`. The
dashboard takes over this duration completely.

```mermaid
flowchart TD
    Start[Run the external ComPython script] --> Install[Check backend and frontend build]
    Install --> Discover[Read active project, study case, QDS and Planned Outages]
    Discover --> Validate[Check all scenario names and outage references]
    Validate --> Valid{Plan valid?}
    Valid -->|No| Stop[Show error, no native calculation]
    Valid -->|Yes| Lodf[Calculate LODF per scenario from DC load flows and store it in pf_lodf]
    Lodf --> Next[Next named scenario]
    Next --> Job[Publish catalog and create job]
    Job --> Calc[Worker calculates REF and OUTAGE]
    Calc --> Saved{Restoration and import successful?}
    Saved -->|No| Fail[Job failed, stop the run]
    Saved -->|Yes| More{More scenarios?}
    More -->|Yes| Next
    More -->|No| Done[All scenarios saved: start the dashboard and open the browser]
```

The LODF calculation runs once before the first simulation and restores every changed state, verified.
If it fails there is a warning; the scenarios run anyway.

Scenarios that were saved successfully are kept if a later calculation fails. Every new batch creates
new result runs with their own IDs; existing results are not overwritten. No `IntScenario` objects are
created: scenario name and outage combination belong to the persisted assessment result.

## 3. REF/OUTAGE and restoration

`calculate()` uses copied ElmRes objects with the existing variable selection. The interventions are
limited in time and are taken back with verification. In the native PF process the script needs only
the standard library and the PowerFactory module; FastAPI runs in its own Python process with the
backend environment.

```mermaid
sequenceDiagram
    participant Batch as start_assessment
    participant Worker as analysis_worker
    participant PF as PowerFactory
    participant DB as SQLite
    Batch->>DB: job with name, selection and catalog fingerprint
    Worker->>DB: take over the job atomically
    Worker->>PF: re-check project and QDS context
    Worker->>PF: save outage flags, iopt_maint, study time and ElmRes binding
    Worker->>PF: selected outserv=0, others outserv=1
    Worker->>PF: REF with iopt_maint=0 on an ElmRes copy
    PF-->>Worker: complete result rows
    Worker->>PF: restore study time
    Worker->>PF: OUTAGE with iopt_maint=1 on an ElmRes copy
    PF-->>Worker: complete result rows
    Worker->>Worker: check time axes and result limits
    Worker->>PF: reset all flags, study time and result binding
    Worker->>PF: remove temporary ElmRes copies
    Worker->>DB: commit scenario plus both result runs together
    DB-->>Batch: scenario saved
```

```mermaid
flowchart TD
    Capture[Capture the original state] --> Run[Calculate REF and OUTAGE]
    Run --> Finally[finally: try to restore]
    Finally --> Restore{Completely verified?}
    Restore -->|No| Reject[Save no results, check the PF state manually]
    Restore -->|Yes| CalcOK{Calculation and time axes valid?}
    CalcOK -->|No| Failed[Mark the job as failed]
    CalcOK -->|Yes| Tx[SQLite transaction: scenario, REF, OUTAGE and samples]
    Tx --> DBOK{Import successful?}
    DBOK -->|No| Rollback[Roll back the whole scenario import]
    DBOK -->|Yes| Done[Job completed]
```

A job that is already running is not re-run automatically. After an abort of the PF process the native
state must be checked before that job is cleaned up explicitly.

## 4. Database model and identity

```mermaid
erDiagram
    PF_CATALOG {
        int id PK
        string payload
        string updated_at
    }
    PF_JOBS {
        string id PK
        string kind
        string payload
        string status
        string message
    }
    PF_SCENARIOS {
        string id PK,FK
        string name
        string project
        string study_case
        string outages
    }
    PF_SCENARIO_RUNS {
        string scenario_id PK,FK
        string run_id PK,FK
        string kind
    }
    ANALYSIS_RUNS {
        string id PK
        string name
        string source
        string status
    }
    ANALYSIS_ELEMENTS {
        string run_id PK,FK
        string id PK
        string name
        string className
        string path
    }
    ANALYSIS_METRICS {
        string run_id PK,FK
        string id PK
        string unit
    }
    ANALYSIS_SAMPLES {
        string run_id PK,FK
        string element_id PK,FK
        string metric_id PK,FK
        string timestamp PK
        float value
        string status
    }
    PF_ELEMENT_LIMITS {
        string run_id PK,FK
        string element_id PK,FK
        string metric_id PK
        float lower
        float upper
    }
    PF_LODF {
        string outage_key PK
        string element_id PK
        float lodf
        float p_pre
        float p_post
    }
    PF_JOBS ||--o| PF_SCENARIOS : produces
    PF_SCENARIOS ||--|{ PF_SCENARIO_RUNS : contains
    ANALYSIS_RUNS ||--o| PF_SCENARIO_RUNS : linked
    ANALYSIS_RUNS ||--|{ ANALYSIS_ELEMENTS : contains
    ANALYSIS_RUNS ||--|{ ANALYSIS_METRICS : contains
    ANALYSIS_ELEMENTS ||--o{ ANALYSIS_SAMPLES : measured
    ANALYSIS_METRICS ||--o{ ANALYSIS_SAMPLES : describes
    ANALYSIS_ELEMENTS ||--o{ PF_ELEMENT_LIMITS : limits
```

SQLite uses WAL and foreign keys. The element hash comes from project path and object path. The frontend
identifier additionally encodes the run ID, so the same equipment in REF and OUTAGE can be selected
separately. Chart legends contain scenario name, run kind and equipment. Renaming in PF changes the
path-based identity.

## 5. Dashboard and complete plots

```mermaid
sequenceDiagram
    participant User as User
    participant UI as Dashboard
    participant API as Simulation API
    participant DB as SQLite
    UI->>API: GET facilities
    API->>DB: read the saved result runs
    API-->>UI: scenario name plus REF or OUTAGE
    User->>UI: scenario, equipment, measurement, Add
    UI->>API: GET timeseries/raw without start/end
    API->>DB: all samples of this selection in time order
    API-->>UI: raw values and optional next_cursor
    loop more pages
        UI->>API: next page with cursor
        API-->>UI: more raw values
    end
    UI->>UI: hand the complete series to the chart
    User->>UI: add the second scenario run
    UI->>UI: show REF and OUTAGE in the overlay
```

There is no hidden filter to the last 30 days and no dashboard period. Old simulations are shown
completely. Chart zoom is a view function. Additional aggregated charts are created only on explicit
choice. Missing or failed values are not invented as zeros. Oversize is reported with an error, not
silently cut off. The native ElmRes read-out limits a result to 35,040 rows; the simulation API accepts
up to 200,000 raw values per selection and pages with at most 50,000 values per page.

## 6. Evaluation across all scenarios

The summary is the standard view. It only reads and changes neither the calculation nor the results.
Details and definitions: [docs/ASSESSMENT.md](docs/ASSESSMENT.md).

### Loading in parts (large databases)

```mermaid
sequenceDiagram
    participant UI as Dashboard
    participant API as Simulation API
    participant DB as SQLite
    UI->>API: GET across-scenarios/index
    API->>DB: scenarios and outages, no samples
    API-->>UI: index at once
    loop per scenario, 3 at a time
        UI->>API: GET across-scenarios/id/cells
        API->>DB: grouped queries REF and OUTAGE, voltage
        API-->>UI: reduced values, cached in the server
        UI->>UI: show the scenario in a fixed order
    end
    UI->>UI: mount sections below the assessment only when scrolled into view
    UI->>API: GET across-scenarios/id/profile only for the chosen scenario
```

Saved scenarios never change; a refresh therefore loads only new ones. The codes S01, S02 … stay stable
because scenarios appear only as a prefix of the order.

### Verdict

```mermaid
flowchart TD
    Cell[Equipment in the outage window: scenario value against REF] --> Over{Above 100 % or voltage band left?}
    Over -->|No| Soft{Reserve below 5 pp, warning range newly reached or voltage near the limit?}
    Over -->|Yes| Cause{REF in the same window also violated?}
    Cause -->|No| Bad[caused]
    Cause -->|Yes, at least 2 pp higher| Worse[aggravated]
    Cause -->|Yes, unchanged| Pre[pre-existing]
    Bad --> No[Not permissible]
    Worse --> No
    Pre --> Cond[Conditionally permissible]
    Soft -->|Yes| Cond
    Soft -->|No| Ok[Permissible]
```

Lines and transformers are assessed by loading, busbars by voltage (band 0.90 to 1.10 p.u., configured
centrally). The verdict is a decision aid, not an approval; the criteria are in
`frontend/src/config/assessment.ts`.

### Reading order and text

Key figures, assessment, profile and scenario details, voltage, matrix, comparison charts and radar,
finally the detail table. A navigation bar follows this order. Explanations are off; the **i** on a card
or **Explanations** shows them. The time series overlay is an optional view under the summary.

## 7. Operation and dashboard process

Everything is on the PowerFactory PC: script, results database and dashboard server. Setup and
maintenance: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

```mermaid
flowchart TD
    Setup[setup.cmd / setup.ps1: once] --> Ready[Python, backend, frontend, configuration]
    Run[start_assessment.py in PowerFactory] --> Pre[Check installation, folder writable, free space]
    Pre --> Calc[Calculate and save scenarios one after another]
    Calc --> Reuse{A server already runs for this database?}
    Reuse -->|Yes| Keep[Reuse it]
    Reuse -->|No| Start[Start the server on 127.0.0.1]
    Keep --> Open[Open the dashboard in the browser]
    Start --> Open
    Auto[Optional autostart serve.py at logon] -.keeps a server ready.-> Reuse
```

- **Configuration:** `scripts/appconfig.py` reads the environment, then `outage-assessment.config.json`,
  then the defaults. Script and autostart use the same file and thus the same database.
- **Server:** `scripts/dashboard_launcher.py` starts it from the script (fixed port 8765; if another
  server holds it, a free port with a note; a running server is reused; detached from the PowerFactory
  process). `scripts/serve.py` is the same server as a permanent process with a rotating log;
  `setup.ps1` sets up Python, the backend environment, the frontend build and the optional per-user
  autostart. It needs no administrator rights and creates no firewall rule.
- **Local by default:** the host is `127.0.0.1`. Only if an operator sets another host (and IT allows
  the port) does the backend run with `APP_ENV=production`: no database switching and protective
  headers. The dashboard has no login.
- **Database:** the script writes, the server reads, both on the same PC through SQLite with WAL. The
  file is never opened over a network share.
- **Dashboard after the calculation:** the script starts (or reuses) the server when the last scenario is saved
  and opens the browser. If the dashboard is already open (autostart), it also shows "PowerFactory is
  calculating: …" and loads new scenarios as soon as they are saved.
- **Package:** `scripts/package_release.py` builds a ZIP with backend, finished frontend, scripts,
  installer and docs, without databases, logs and local configuration.
- **Mac development:** `start-dashboard.command` binds only to `127.0.0.1` and keeps the terminal open.

## 8. Mac start with an existing database

```mermaid
flowchart TD
    Command[start-dashboard.command --db file] --> Setup[uv sync and npm ci when the lock file changed]
    Setup --> Build[Build the frontend]
    Build --> Check[Check file and schema, never create]
    Check --> Launch[Start the local dashboard]
    Launch --> Browser[Real SQLite queries]
    Browser --> Stop[Ctrl+C ends the own server]
```

The real PF default is `backend/data/outage-assessment.sqlite3`. Synthetic data exists only as a test
fixture (`backend/tests/qds_fixture.py`) for backend tests and the browser smoke test.

## 9. Tests and real acceptance

### Switching the local database

```mermaid
flowchart TD
    Start[start-dashboard.command --db or PowerFactory configuration] --> Active[Active local SQLite file]
    Button[Header: add database] --> Path[Enter an absolute file path]
    Path --> Check[POST /api/simulation/database: check existing file and schema]
    Check -->|Invalid| Error[Show error, keep the previous selection]
    Check -->|Valid| Switch[Switch the active repository and database path]
    Switch --> Reload[Clear frontend cache and saved selection, reload]
    Active --> Queries[API reads complete series]
    Reload --> Queries
    Queries --> Charts[Charts]
```

The path names a file on the machine of the server, with PowerFactory the PC itself. The selection
changes neither the stored measurements nor the start configuration. Old repository connections stay
available for running queries until the server ends. Switching is disabled when the server is exposed
to the network.

### Presentation and build

The light-mode variables and rules that apply only under `[data-grid-theme="light"]` in
`frontend/src/index.css` control the visual adaptation. The dark-mode and shared layout rules are
unchanged.

Vite loads charts dynamically. The ECharts libraries are distributed over Rolldown chunk groups with
`maxSize`; the warning threshold stays at 650 kB.

Worker tests use a native API replacement and check single outages, named combinations, batch
processing, state restoration and atomic persistence. The production smoke test starts the same
dashboard launcher with an isolated synthetic test database. Browser checks verify complete series even
with old timestamps, and the removed login, footer and date filter.

A real PowerFactory 2026 run on Windows remains necessary. In particular the mapping between ElmRes
timestamp, interval end and Planned Outage window that is still open in the GridLens project must be
checked technically. The application does not shift these timestamps automatically.
