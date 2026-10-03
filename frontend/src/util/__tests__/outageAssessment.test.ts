import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessScenario,
  causeCounts,
  causeOf,
  equipmentKind,
  verdictCounts,
  voltageResult,
} from '../outageAssessment.ts';
import type { AcrossBus, AcrossBusCell, AcrossCell, AcrossLine, AcrossScenario } from '../acrossScenarios.ts';

const scenario: AcrossScenario = { id: 's', name: 'S', outages: [], outaged_element_ids: [], has_lodf: false };
const cell = (value: number | null, base: number | null, outaged = false): AcrossCell => ({
  outaged, value, window_base: base, delta: value === null || base === null ? null : value - base, lodf: null, hours_over: null,
});
const line = (name: string, c: AcrossCell, type = 'line'): AcrossLine => ({ id: name, name, class_name: null, type, base: null, cells: { s: c } });
const bus = (limits: [number, number] | null, ref: [number, number], out: [number, number], unit = 'p.u.'): AcrossBus => ({
  id: 'b', name: 'SS', class_name: null, type: 'bus', unit, limits,
  cells: { s: { outaged: false, ref, out, hours_outside: null } as AcrossBusCell },
});

test('cause: new, aggravated and unchanged overloads are told apart', () => {
  assert.equal(causeOf(cell(95, 60)), null);
  assert.equal(causeOf(cell(105, 90)), 'caused');
  assert.equal(causeOf(cell(118, 104)), 'aggravated');
  assert.equal(causeOf(cell(104.5, 104)), 'preexisting');
  assert.equal(causeOf(cell(100, 60)), null); // exactly 100 % is not an overload
  assert.equal(causeOf(cell(130, 60, true)), null); // switched-off equipment has no verdict
});

test('equipment kinds cover lines, transformers and everything else', () => {
  assert.equal(equipmentKind('line'), 'line');
  assert.equal(equipmentKind('transformer'), 'transformer');
  assert.equal(equipmentKind('coupler'), 'other');
});

test('voltage in p.u. is judged against the configured band 0.90 to 1.10, whatever limits were stored', () => {
  const stored: [number, number] = [0.95, 1.05]; // must be ignored for p.u. results
  assert.equal(voltageResult(bus(stored, [0.99, 1.02], [0.98, 1.02]), undefined).state, 'unknown');
  const b1 = bus(stored, [0.99, 1.02], [0.93, 1.02]); // outside 0.95 but inside 0.90
  assert.equal(voltageResult(b1, b1.cells.s).state, 'ok');
  const b2 = bus(stored, [0.99, 1.02], [0.91, 1.02]);
  assert.equal(voltageResult(b2, b2.cells.s).state, 'near');
  const b3 = bus(stored, [0.99, 1.02], [0.88, 1.02]);
  assert.deepEqual([voltageResult(b3, b3.cells.s).state, voltageResult(b3, b3.cells.s).cause], ['violated', 'caused']);
  const b3o = bus(stored, [1.0, 1.04], [1.0, 1.107]); // overvoltage
  assert.equal(voltageResult(b3o, b3o.cells.s).state, 'violated');
  const b4 = bus(stored, [0.898, 1.02], [0.898, 1.02]);
  assert.equal(voltageResult(b4, b4.cells.s).cause, 'preexisting');
  const b5 = bus(stored, [0.898, 1.02], [0.87, 1.02]);
  assert.equal(voltageResult(b5, b5.cells.s).cause, 'aggravated');
});

test('voltage in kV uses the stored limits; without limits nothing is derived', () => {
  const kv = bus([360, 420], [380, 400], [350, 400], 'kV');
  assert.deepEqual([voltageResult(kv, kv.cells.s).state, voltageResult(kv, kv.cells.s).cause], ['violated', 'caused']);
  const none = bus(null, [380, 400], [300, 500], 'kV');
  assert.equal(voltageResult(none, none.cells.s).state, 'unknown');
});

test('verdict: not permissible when the outage causes an overload, naming the worst element', () => {
  const a = assessScenario(scenario, [line('L1', cell(128, 70)), line('L2', cell(60, 58))]);
  assert.equal(a.verdict, 'not-permissible');
  assert.equal(a.caused, 1);
  assert.match(a.reasons[0], /L1 128\.0 %/);
});

test('verdict: a pre-existing overload alone is only conditional', () => {
  const a = assessScenario(scenario, [line('L1', cell(104.5, 104)), line('L2', cell(50, 50))]);
  assert.equal(a.verdict, 'conditional');
  assert.equal(a.preexisting, 1);
});

test('verdict: pushed into the warning range is conditional, calm scenarios are permissible', () => {
  assert.equal(assessScenario(scenario, [line('L1', cell(85, 60))]).verdict, 'conditional');
  const calm = assessScenario(scenario, [line('L1', cell(70, 65)), line('T1', cell(40, 40), 'transformer')]);
  assert.equal(calm.verdict, 'permissible');
  assert.equal(calm.worst?.name, 'L1');
  assert.ok(Math.abs((calm.worst?.reserve ?? 0) - 30) < 1e-9);
});

test('verdict: voltage violation caused by the outage makes the scenario not permissible, transformers count like lines', () => {
  const v = assessScenario(scenario, [line('L1', cell(50, 50))], [bus([0.95, 1.05], [0.99, 1.02], [0.89, 1.02])]);
  assert.equal(v.verdict, 'not-permissible');
  assert.equal(v.voltageViolations, 1);
  const t = assessScenario(scenario, [line('T1', cell(112, 80), 'transformer')]);
  assert.equal(t.verdict, 'not-permissible');
});

test('the outaged equipment itself is never judged; a scenario without values is not assessable', () => {
  assert.equal(assessScenario(scenario, [line('L1', cell(null, null, true))]).verdict, 'unknown');
  const counts = verdictCounts([assessScenario(scenario, [line('L', cell(50, 50))]), assessScenario(scenario, [line('L', cell(120, 50))])]);
  assert.deepEqual(counts, { permissible: 1, conditional: 0, 'not-permissible': 1, unknown: 0 });
});

test('verdict: little thermal reserve left by the outage is conditional, but only when the outage causes it', () => {
  const pushedUp = assessScenario(scenario, [line('L1', cell(97, 60))]);
  assert.equal(pushedUp.verdict, 'conditional');
  assert.equal(pushedUp.lowReserve, 1);
  assert.match(pushedUp.reasons[0], /reserve < 5 pp/);
  // Already that high without the outage: not attributable to it.
  assert.equal(assessScenario(scenario, [line('L1', cell(97, 96))]).verdict, 'permissible');
});

test('cause counts tell outage-caused overloads from the load a branch already carried', () => {
  const l = line('L', cell(0, 0));
  l.cells = { a: cell(105, 90), b: cell(118, 104), c: cell(104.5, 104), d: cell(60, 60), e: cell(null, null, true) };
  assert.deepEqual(causeCounts(l, ['a', 'b', 'c', 'd', 'e', 'missing']), { caused: 2, preexisting: 1 });
  assert.deepEqual(causeCounts(l, []), { caused: 0, preexisting: 0 });
});
