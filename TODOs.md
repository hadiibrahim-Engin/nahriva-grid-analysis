# TODOs

- [x] **Redispatch hourly energy and price import — resumed by the user on 2026-11-19.** Contract 1 accepts supplied
  MWh and EUR/MWh per generator, scenario and complete UTC hour. Layout 18 stores immutable delivery revisions;
  the standalone map, scenario/hour heatmap and generator table display signed costs. Archives preserve deliveries.
- [ ] **External Redispatch adapters.** Confirm source samples, measure IDs, external asset mappings, settlement
  signs, sub-hour integration and correction/cancellation semantics before implementing source-specific adapters.

Requested/planned/delivered is explicit per delivery. A new complete delivery supersedes the displayed revision;
absent rows stay unknown. REF/OUTAGE active-power differences must not be treated as Redispatch. Future adapters
must use the existing serialized write path and the confirmed source conventions.

Details: [Redispatch open item](docs/REDISPATCH.md) and
[original requirements](output/prompts/datenbank-redispatch-prompt.md).
