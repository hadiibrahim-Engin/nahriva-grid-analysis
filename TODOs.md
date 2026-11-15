# TODOs

- [ ] **Redispatch support — deferred by the user on 2026-11-15.** Specify the source-independent import contract,
  then implement the versioned data model, storage, summaries and validation tests. No Redispatch schema,
  importer, adapter, energy calculation or dashboard has been implemented yet; layout 15 covers existing result
  storage only.

Before implementation, clarify the delivery format/sample, requested/planned/delivered quantity types,
reference schedule or run, sign conventions and units, UTC intervals/integration rules, external asset IDs and
versioned mappings, and correction/cancellation semantics. An REF/OUTAGE active-power difference alone must
not be treated as Redispatch. Future imports must use the existing serialized write path.

Details: [Redispatch open item](docs/REDISPATCH.md) and
[original requirements](output/prompts/datenbank-redispatch-prompt.md).
