# Areas: load, generation and transit

The widget **Areas** shows per area (grid, `ElmNet`) of a scenario run, against REF:

| Question | View |
|---|---|
| Which area consumes, which feeds in? | table (mean and peak load, generation, net balance) and the balance chart: generation above zero, load below, net as a line (export positive, import negative), outage windows shaded |
| Where does the power flow? | flow graph: one node per area (size: mean load, green exports, red imports), arrows with the mean flow between areas; tooltip: strongest flow and the share of time in that direction |
| Which area only passes power on? | transit per area over time: the smaller of import and export at each time |
| When is an area under pressure? | heat map area × day of the mean net balance; tooltip with lowest, highest and the highest load of the day |
| What does a planned outage change? | peak import of the scenario against REF in the table |

The time range of the toolbar applies to all of it; CSV exports the table, every chart exports PNG.

## What PowerFactory has to record

The dashboard evaluates what the engineer chose in **ComStatsim → Result Variables**. With these variables the
analysis is possible; without them the widget says *Cannot evaluate* and lists what is missing:

| For | Variable |
|---|---|
| balance per area | active power of loads: `m:P:bus1` of `ElmLod` (also `ElmLodlv`, `ElmLodmv`) |
| balance per area | active power of generators and external grids: `m:P:bus1` of `ElmSym`, `ElmGenstat`, `ElmPvsys`, `ElmXnet` |
| flows between areas, transit | active power of lines and transformers: `m:P:bus1` of `ElmLne`, `m:P:bushv` of `ElmTr2`/`ElmTr3` |

An area is the grid of an element. A branch connects the grids of its two terminals (`bus1`/`bus2`, `bushv`/`buslv`),
which the bridge reads at import (`gl_branch_ends`); a branch whose terminals lie in two grids carries the flow
between them. Elements outside the recorded variables simply do not count; a value PowerFactory did not deliver is
counted as missing for that time (shown in the table), never as 0.

## How it stays fast

The bridge sums the active power per area and time while it imports a run (`pf_area_times`) and the flows per pair
of areas (`pf_area_flows`); a request reads these few rows (about 40 ms for the example, independent of the number
of elements) and reduces long courses to the highest values per interval (peaks survive). Runs imported before
these tables existed say so and need to be calculated again.

## Signs and limits

- Signs as PowerFactory reports them: loads positive when consuming, generators and external grids positive when
  feeding in, a branch positive from its first terminal into the branch (assumption A9 in `dev.md`, to verify on a
  real run).
- Net balance = generation − load. It equals the flows over the tie branches only without losses; with real
  results the difference is the losses of the area.
- A three-winding transformer is counted between its HV and LV side; its MV side is not used.
- Grouping is by grid (`ElmNet`); PowerFactory areas or zones (`ElmArea`, `ElmZone`) are not used yet.

## Example

`scripts/try_example.sh` (and the Windows test package) builds the IEEE 39-bus system with its loads and
generators and a DC load flow, so loadings, balances and flows are consistent: the net balance of every area equals
the flows over its tie branches (tested in `backend/tests/test_areas.py`).
