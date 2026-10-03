import test from 'node:test';
import assert from 'node:assert/strict';

import { busValue, chosenLines, pickBuses, pickChosen, pickScenarios, restrictScenarios, tightestMargin } from '../acrossSelection.ts';
import type { AcrossBus, AcrossData, AcrossLine, AcrossScenario } from '../acrossScenarios.ts';

const sc = (id: string): AcrossScenario => ({ id, name: id, outages: [], outaged_element_ids: [], has_lodf: false });
const scenarios = [sc('a'), sc('b'), sc('c')];
const bus = (id: string, out: [number, number], ref: [number, number] = [1, 1.02], unit = 'p.u.'): AcrossBus => ({
  id, name: id, class_name: null, type: 'bus', unit, limits: null,
  cells: { a: { outaged: false, ref, out, hours_outside: 0 } },
});
const line = (id: string): AcrossLine => ({ id, name: id, class_name: null, type: 'line', base: 50, cells: {} });

test('chosen scenarios keep their fixed order; none chosen means all', () => {
  assert.deepEqual(pickScenarios(scenarios, ['c', 'a']).map((s) => s.id), ['a', 'c']);
  assert.equal(pickScenarios(scenarios, []).length, 3);
  assert.equal(pickScenarios(scenarios, undefined).length, 3);
  const data = { scenarios, lines: [], has_lodf: false, period_hours: 1, limits: [100] } as AcrossData;
  assert.equal(restrictScenarios(data, ['b']).scenarios.length, 1);
});

test('chosen equipment is shown exactly, in name order; vanished ids are ignored', () => {
  const lines = [line('L3'), line('L1'), line('L2')];
  assert.deepEqual(chosenLines(lines, { elementMode: 'selected', elementIds: ['L3', 'L1', 'gone'] })?.map((l) => l.id), ['L1', 'L3']);
  assert.equal(chosenLines(lines, { elementMode: 'auto' }), null); // automatic: the caller applies its top N
  assert.deepEqual(pickChosen(lines, []), []);
});

test('voltage value is the extreme closer to the band (0.90 to 1.10 p.u.) with its change against REF', () => {
  const low = busValue(bus('b1', [0.93, 1.02]), bus('b1', [0.93, 1.02]).cells.a);
  assert.deepEqual([low?.side, low?.value], ['low', 0.93]);
  assert.ok(Math.abs((low?.margin ?? 0) - 0.03) < 1e-9);
  assert.ok(Math.abs((low?.delta ?? 0) - (0.93 - 1)) < 1e-9);
  const high = busValue(bus('b2', [1.0, 1.107]), bus('b2', [1.0, 1.107]).cells.a);
  assert.deepEqual([high?.side, high?.value], ['high', 1.107]);
  assert.ok((high?.margin ?? 0) < 0); // above 1.10: the band is left
  assert.equal(busValue(bus('b3', [1, 1]), undefined), null);
  const gone = bus('b4', [1, 1]);
  gone.cells.a.outaged = true;
  assert.equal(busValue(gone, gone.cells.a), null);
});

test('automatic busbar choice takes the tightest margins; a manual choice is exact', () => {
  const buses = [bus('calm', [0.99, 1.0]), bus('tight', [0.905, 1.0]), bus('over', [1.0, 1.12])];
  assert.deepEqual(pickBuses(buses, scenarios, { topN: 2 }).map((b) => b.id), ['over', 'tight']);
  assert.ok(tightestMargin(buses[2], scenarios) < 0);
  assert.deepEqual(pickBuses(buses, scenarios, { elementMode: 'selected', elementIds: ['calm'] }).map((b) => b.id), ['calm']);
  assert.deepEqual(pickBuses(buses, scenarios, { elementMode: 'selected', elementIds: [] }), []);
});

test('kV results without stored limits fall back to the side farther from nominal', () => {
  const kv = bus('kv', [372, 389], [380, 382], 'kV');
  assert.equal(busValue(kv, kv.cells.a)?.side, 'low');
});
