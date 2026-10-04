import test from 'node:test';
import assert from 'node:assert/strict';

import { gridLabel, inGrid, restrictToGrid } from '../grids.ts';
import type { AcrossBus, AcrossData, AcrossLine } from '../acrossScenarios.ts';

const line = (id: string, grid?: string): AcrossLine => ({ id, name: id, class_name: null, type: 'line', grid, base: 50, cells: {} });
const bus = (id: string, grid: string): AcrossBus => ({ id, name: id, class_name: null, type: 'bus', grid, limits: null, cells: {} });
const data = {
  scenarios: [{ id: 's', name: 's', outages: [], outaged_element_ids: [], has_lodf: false }],
  lines: [line('a', 'D7 Grid'), line('b', 'D8 Grid'), line('c')],
  buses: [bus('x', 'D7 Grid'), bus('y', 'D8 Grid')],
  has_lodf: false,
  period_hours: 1,
  limits: [100],
} as AcrossData;

test('one grid keeps only its branches and busbars, never the scenarios', () => {
  const d7 = restrictToGrid(data, 'D7 Grid');
  assert.deepEqual(d7.lines.map((l) => l.id), ['a']);
  assert.deepEqual(d7.buses?.map((b) => b.id), ['x']);
  assert.equal(d7.scenarios.length, 1);
});

test('all grids leaves the data untouched; elements without a grid form their own group', () => {
  assert.equal(restrictToGrid(data, null), data);
  assert.deepEqual(restrictToGrid(data, '').lines.map((l) => l.id), ['c']);
  assert.equal(inGrid({ grid: undefined }, ''), true);
  assert.equal(gridLabel(''), '(no grid)');
});

test('the grid of each element survives merging the scenarios loaded one by one', async () => {
  const { mergeCells } = await import('../acrossLoad.ts');
  const cell = { outaged: false, value: 1, window_base: 1, delta: 0, lodf: null, hours_over: null };
  const merged = mergeCells(
    { scenarios: data.scenarios, period: null, has_lodf: false },
    { s: {
      scenario_id: 's', period_hours: 1, voltage_unit: 'p.u.',
      lines: [{ id: 'a', name: 'a', class_name: null, type: 'line', grid: 'D7 Grid', ref_full: 1, cell }],
      buses: [{ id: 'x', name: 'x', class_name: null, type: 'bus', grid: 'D8 Grid', unit: 'p.u.', limits: null,
        cell: { outaged: false, ref: null, out: null, hours_outside: null } }],
    } },
  );
  assert.equal(merged.lines[0].grid, 'D7 Grid');
  assert.equal(merged.buses?.[0].grid, 'D8 Grid');
  assert.deepEqual(restrictToGrid(merged, 'D7 Grid').lines.map((l) => l.id), ['a']);
});
