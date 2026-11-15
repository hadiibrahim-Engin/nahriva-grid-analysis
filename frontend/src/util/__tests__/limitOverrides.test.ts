import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize } from '../../config/overrides.ts';
import { DEFAULT_LOADING_LIMITS, LOADING_LIMITS } from '../../config/loadingBands.ts';
import { cellsQuery, mergeCells, type AcrossIndex, type CellsPayload } from '../acrossLoad.ts';

test('only finite, non-negative values of known limits are kept', () => {
  assert.deepEqual(sanitize({ warning: 75, overload: '100', clear: -1, severe: Infinity, other: 3, voltageLower: 0.92 }),
    { warning: 75, voltageLower: 0.92 });
  assert.deepEqual(sanitize(null), {});
});

test('without stored changes the defaults apply, and the cells request carries them', () => {
  assert.deepEqual(LOADING_LIMITS, DEFAULT_LOADING_LIMITS);
  const query = cellsQuery(['a', 'b']);
  assert.deepEqual(query.getAll('ids'), ['a', 'b']);
  assert.deepEqual(query.getAll('over'), ['100', '110', '120']);
  assert.equal(query.get('warning'), '80');
  assert.equal(query.get('band_lower'), '0.9');
});

test('a large analysis says how many elements are listed, as the union over its scenarios', () => {
  const cell = { outaged: false, value: 90, window_base: 80, delta: 10, hours_over: [0, 0, 0], lodf: null };
  const part = (id: string, lines: string[]): CellsPayload => ({
    scenario_id: id, period_hours: 24, voltage_unit: 'p.u.', buses: [],
    lines: lines.map((name) => ({ id: name, name, class_name: 'ElmLne', type: 'line', ref_full: 80, cell })),
    listing: { lines: 100000, buses: 100000, listed_lines: lines.length, listed_buses: 0, warning: 80, band: [0.9, 1.1], margin: 0.02, top: 500 },
  });
  const index = { scenarios: [{ id: 's1', name: 'S1', outages: [] }, { id: 's2', name: 'S2', outages: [] }], period: null } as unknown as AcrossIndex;
  const merged = mergeCells(index, { s1: part('s1', ['A', 'B']), s2: part('s2', ['B', 'C']) });
  assert.equal(merged.listing?.lines, 100000);
  assert.equal(merged.listing?.listed_lines, 3);
  const small = mergeCells(index, { s1: { ...part('s1', ['A']), listing: undefined } });
  assert.equal(small.listing, null);
});
