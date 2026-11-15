# Redispatch — open work item

Deferred at the user's request on 2026-11-15. This change implements no Redispatch schema, importer, adapter,
energy calculation or dashboard. Layout 15 only adds storage-location visibility for existing results.

The detailed future requirements remain in [the original work brief](../output/prompts/datenbank-redispatch-prompt.md).
An active-power difference between REF and OUTAGE is not evidence of a Redispatch measure.

Before connecting a real source, obtain:

- Delivery format and a representative sample, external delivery/measure IDs and correction/cancellation rules.
- Whether quantities are requested, planned or delivered; whether energy is supplied or must be derived.
- Explicit reference schedule/run and after-measure result, including links to analysis/scenario/runs.
- Source- and asset-specific sign conventions, MW/MWh units and the integration rule for point observations.
- Actual UTC interval boundaries, time grid, gap/quality rules and external asset IDs with versioned mappings.

Any future writer must participate in `app.simulation.imports.serialized(database)`. Normal dashboard reads remain
free of import and network calculations. Existing `analysis_series(run_id, metric_id, element_id)` does not encode
measure, delivery revision or schedule type and must not be reused as though it did.
