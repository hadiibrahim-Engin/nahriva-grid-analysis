/**
 * Unit tests for the Add-chart required-measurement gate.
 *
 * Runs on Node's built-in test runner with native TypeScript type-stripping
 * (Node ≥ 23). No extra dependency — the project is on Vite 8, ahead of
 * Vitest's supported peer range. `missingRequiredMeasurements` is framework
 * free, so this exercises the exact logic the picker uses to block invalid
 * charts.
 *
 *   npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { missingRequiredMeasurements, type DashboardSeries } from '../dynamicCharts.ts';

function series(componentId: string, measurementType: string): DashboardSeries {
  return {
    key: `${componentId}-${measurementType}`,
    facilityName: 'AnlageX',
    facilityId: 'F1',
    componentId,
    componentName: 'Trafo 1',
    measurementType,
  };
}

// A component "C1" that has full P/Q/S, plus an unrelated U on C2.
const FULL_PQS = [series('C1', 'P'), series('C1', 'Q'), series('C1', 'S'), series('C2', 'U')];

test('no requirement → never blocks', () => {
  assert.deepEqual(missingRequiredMeasurements(undefined, ['C1-P'], FULL_PQS), []);
  assert.deepEqual(missingRequiredMeasurements([], ['C1-P'], FULL_PQS), []);
});

test('power factor: all of P/Q/S present → nothing missing', () => {
  assert.deepEqual(missingRequiredMeasurements(['P', 'Q', 'S'], ['C1-P'], FULL_PQS), []);
});

test('power factor: only P loaded → Q and S reported missing', () => {
  const onlyP = [series('C1', 'P'), series('C2', 'U')];
  assert.deepEqual(missingRequiredMeasurements(['P', 'Q', 'S'], ['C1-P'], onlyP), ['Q', 'S']);
});

test('no source chosen yet → gate closed, all required reported', () => {
  assert.deepEqual(missingRequiredMeasurements(['P', 'Q', 'S'], [], FULL_PQS), ['P', 'Q', 'S']);
});

test('requirement is component-scoped: P/Q/S on a different component does not count', () => {
  // Selected source is C2 (only U); the P/Q/S live on C1 → still missing.
  assert.deepEqual(
    missingRequiredMeasurements(['P', 'Q', 'S'], ['C2-U'], FULL_PQS),
    ['P', 'Q', 'S'],
  );
});

test('multiple selected components → union of what each is missing', () => {
  const data = [
    series('C1', 'P'), series('C1', 'Q'), series('C1', 'S'), // C1 complete
    series('C2', 'P'),                                        // C2 only P
  ];
  // Selecting one source from each component; C2 lacks Q and S.
  assert.deepEqual(
    missingRequiredMeasurements(['P', 'Q', 'S'], ['C1-P', 'C2-P'], data).sort(),
    ['Q', 'S'],
  );
});

test('unknown source key is ignored (treated as no component)', () => {
  assert.deepEqual(missingRequiredMeasurements(['P', 'Q', 'S'], ['does-not-exist'], FULL_PQS), [
    'P', 'Q', 'S',
  ]);
});
