# Redispatch: supplied hourly energy and prices

The standalone map workspace (`/network`, linked as **Netzkarte** in the dashboard) shows generator power and
Redispatch energy, price and cost at the selected UTC hour across all scenarios of one analysis. A generator
click stays on the map and selects its cross-scenario inspector. The time heatmap can show known hourly costs;
the generator table switches between the current scenario and all scenarios and exports CSV.

## Import contract 1

The user confirmed on 2026-11-19 that Redispatch energy (MWh) and price (EUR/MWh) are supplied. Costs are their
signed product, calculated and stored using Decimal, not inferred from REF/OUTAGE active-power differences.
No point-sample energy integration or sub-hour allocation is performed.

**Redispatch importieren** accepts a UTF-8 comma-separated CSV with these exact columns (decimal point):

```csv
scenario_id,element_id,start_utc,end_utc,energy_mwh,price_eur_per_mwh
<scenario-id>,<generator-id>,2025-04-12T05:00:00Z,2025-04-12T06:00:00Z,2.5,80
```

- Each row is one complete UTC hour `[start, end)` and one aggregated generator/scenario quantity. UTC offsets
  must be explicit and zero; local times, ambiguous DST times and fractional hours are rejected.
- IDs must belong to the selected analysis. Download **Szenario- und Kraftwerk-IDs** from the import dialog for
  the mapping. Only recorded `ElmSym`, `ElmGenstat` and `ElmPvsys` generators are accepted; external grids are
  not treated as power plants. No name-based or external-ID mapping is guessed.
- Select the quantity kind: requested, planned or delivered. It is stored with the source file name and creation
  time. Max. 10 MB of CSV text and 50,000 rows; nonfinite, excessive-precision and duplicate keys are rejected.
- Each upload is a complete delivery revision for the analysis. The newest revision is displayed; prior
  revisions remain in the database and archive. Corrections/cancellations must be supplied as a new complete
  delivery, with explicit zero rows where zero is intended. No row-level cancellation adapter is implemented.
- Missing hours/generators/scenarios remain unknown, never 0 EUR. The network-wide figure is labelled as known
  costs, a partial sum. Negative MWh and prices retain their signs; no absolute-value settlement rule is assumed.
  The UI displays EUR with currency rounding; stored products are not rounded to cents.

`POST /api/simulation/redispatch/import` takes `analysis`, `source`, `quantity_kind` and `csv`. Local import follows
the database-switch capability and is disabled by default in network/production operation. The writer acquires
`app.simulation.imports.serialized(database)` and publishes the delivery in one transaction.

## Storage and archive

Layout 18 adds `rd_imports` (source, quantity kind, contract version, revision) and `rd_hours` (scenario, generator,
UTC interval, energy, price, exact cost as decimal strings). Existing analysis and native result contracts remain
unchanged. Archives include every delivery revision and restore validates ownership and cost arithmetic. Earlier
archives without Redispatch tables can still be restored.

`GET /api/simulation/network/timeline` returns the shared calculated clock and bounded scenario/time heatmap;
cells retain real peak timestamps. `GET /api/simulation/network/at-time?t=...` returns simultaneous scenario and
generator values plus costs for the UTC hour containing `t`. A missing QDS sample is not interpolated; an imported
cost hour without QDS remains navigable. Network-wide loading summaries and the network-wide heatmap explicitly
cover all grids; grid/voltage filters restrict map emphasis and the generator table.

## Demo and remaining adapters

`backend/.venv/bin/python scripts/prepare_network_demo.py` creates a separate copy of the existing synthetic
IEEE39 example, voltage-coloured generator SVG layers and explicitly synthetic hourly Redispatch rows. The
current example covers 673 hours around all six maintenance periods, nine generators and all six scenarios
(36,342 rows). Daily morning/evening profiles, weekday/weekend demand and slowly varying weather drive a
congestion-dependent planning volume. Three units increase and three decrease output with exactly balanced
MWh; the other three remain at zero. Outside a scenario's maintenance window, or below the congestion threshold,
explicit zeros are supplied. Upward offers exceed avoided downward generation costs, so signed credits and
net positive hourly costs are visible. Missing hours outside the delivery remain unknown.

This illustrative planning model is not an economic dispatch optimiser or a post-Redispatch power-flow
calculation; native QDS results continue to show the original pre-Redispatch state. The page labels this clearly
as synthetic data. The source database is never changed. `--refresh-demo` refreshes only a previously labelled
IEEE39 demo, adds an immutable delivery revision and updates its demo SVG; earlier revisions remain available.

The original deferred brief remains in `output/prompts/datenbank-redispatch-prompt.md`. External source formats,
measure IDs, versioned external-asset mappings, sub-hour deliveries, settlement-specific sign rules and automatic
source-system correction/cancellation handling still require a representative source sample and adapter.
