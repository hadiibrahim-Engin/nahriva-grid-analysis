import test from 'node:test';
import assert from 'node:assert/strict';

import { committedPrefix, mergeCells, type AcrossIndex, type CellsPayload } from '../acrossLoad.ts';
import type { AcrossCell } from '../acrossScenarios.ts';

const scenario = (id: string, lodf = false) => ({ id, name: id, outages: [], outaged_element_ids: [], has_lodf: lodf });
const index: AcrossIndex = { scenarios: [scenario('a'), scenario('b', true), scenario('c')], period: [0, 3600], has_lodf: true };
const cell = (value: number): AcrossCell => ({ outaged: false, value, window_base: value - 1, delta: 1, lodf: null, hours_over: [0, 0, 0] });
const part = (id: string, value: number, refFull: number, hours = 24): CellsPayload => ({
  scenario_id: id, period_hours: hours, voltage_unit: 'p.u.',
  lines: [{ id: 'L', name: 'L', class_name: null, type: 'line', ref_full: refFull, cell: cell(value) }],
  buses: [{ id: 'B', name: 'B', class_name: null, type: 'bus', unit: 'p.u.', limits: [0.9, 1.1], cell: { outaged: false, ref: [1, 1], out: [0.95, 1], hours_outside: 0 } }],
});

test('merge assembles lines and busbars across scenarios; base is the largest REF maximum', () => {
  const data = mergeCells(index, { a: part('a', 80, 60), b: part('b', 90, 70, 48), c: part('c', 70, 65) });
  assert.equal(data.scenarios.length, 3);
  assert.equal(data.lines.length, 1);
  assert.equal(data.lines[0].base, 70);
  assert.deepEqual(Object.keys(data.lines[0].cells), ['a', 'b', 'c']);
  assert.equal(data.period_hours, 48);
  assert.equal(data.buses[0].limits?.[1], 1.1);
  assert.equal(data.has_lodf, true);
});

test('progressive loading keeps the scenario order: only a prefix is shown, codes stay stable', () => {
  // c arrives first, a is still missing → nothing is committed yet.
  assert.deepEqual(Object.keys(committedPrefix(index, { c: part('c', 70, 65) })), []);
  // a and c arrived, b is pending → only a.
  assert.deepEqual(Object.keys(committedPrefix(index, { a: part('a', 80, 60), c: part('c', 70, 65) })), ['a']);
  const all = committedPrefix(index, { a: part('a', 80, 60), b: part('b', 90, 70), c: part('c', 70, 65) });
  assert.deepEqual(Object.keys(all), ['a', 'b', 'c']);
});

test('a failed scenario is skipped without blocking the following ones', () => {
  const prefix = committedPrefix(index, { a: part('a', 80, 60), b: null, c: part('c', 70, 65) });
  assert.deepEqual(Object.keys(prefix), ['a', 'c']);
  assert.equal(mergeCells(index, prefix).scenarios.length, 2);
});
