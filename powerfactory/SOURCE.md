# Origin of the PowerFactory functions

`gridlens_engine.py` is an unchanged copy of `gridlens-powerfactory/powerfactory/gridlens_report.py`
from the local working state, including the changes already present there. Base commit:
`cae2064b0b8b60efaa96e07c617a89585b179d81`.
SHA-256 of both files when taken over:
`23797cd121b5b80ba01be23e16d52a93b608e314422f7bd5cd1e7a1379c3cb25`.

`analysis_worker.py` uses its discovery, ComStatsim, ElmRes and restoration functions. The original
report publisher is not started. For database storage `MAX_PLOT_POINTS` is set to `MAX_RESULT_ROWS` at
runtime so that nothing is thinned to 200 report points. `GRID_NAME_FILTER` is taken over by the worker
and is empty by default.

The dashboard components come from `DashB/Api-main/frontend`, commit
`6134be87e2dd3629510cbbf10d054cec68dc3a53`. Changes concern the connection to simulation data, the
outage management and the related labels. The original source projects are not changed.

Testing with an API replacement does not replace a native PowerFactory acceptance. In particular,
outage windows and ElmRes timestamps must be checked in a real PowerFactory 2026 project on Windows.

`start_assessment.py` adds the native batch entry point, the configurable results file and the start of
the local dashboard.
