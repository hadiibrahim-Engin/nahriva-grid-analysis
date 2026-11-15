# Active GridLens runtime (Outage Assessment 8.1.0)

`gridlens_runtime.py` is `GridLensAssessment/outage-assessment/main.py` (publisher 8.1.0, the tkinter case
manager), source SHA-256 `4563868826ecd447e557eb75d92bcc5980e3dec4b1600ebfb8c600d4314bfc5a`. The case manager,
case planning, QDS/n-1/(n-1)' calculation and restoration are main.py's own. The only change:
`execute_outage_assessment(app, result_consumer=None)` hands the restored native runs to `result_consumer`
after verified restoration and before report evaluation (no report tables, no IntReport, no PDF). The
starter always supplies this hook. To update: copy main.py again and re-apply these three small edits
(signature, dashboard-mode context note, hand-off after "Original PowerFactory state restored and verified").

`gridlens_dashboard.py` reads the native results into the local dashboard database without report
classification or publication. The normal entry point is `start_assessment.py`. See `docs/GRIDLENS.md`.

The dashboard components come from `DashB/Api-main/frontend`, commit
`6134be87e2dd3629510cbbf10d054cec68dc3a53`. Changes concern the connection to simulation data, the
outage management and the related labels. The original source projects are not changed.

Testing with an API replacement does not replace a native PowerFactory acceptance. In particular,
outage windows and ElmRes timestamps must be checked in a real PowerFactory 2026 project on Windows.
