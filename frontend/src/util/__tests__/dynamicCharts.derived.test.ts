/**
 * Unit tests for the client-side derived-chart calculations.
 * Run with: npm run test:unit  (Node built-in test runner + TS type-stripping)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEnergyIntegral,
  buildLoading,
  buildOverloadDuration,
  buildLosses,
  buildAnomalyScore,
  buildVoltageBand,
  type DashboardSeries,
} from '../dynamicCharts.ts';
import type { TimeseriesData } from '../../api/client.ts';

function src(componentId = 'C1', measurementType = 'P'): DashboardSeries {
  return {
    key: `${componentId}-${measurementType}`,
    facilityName: 'F', facilityId: 'F1', componentId, componentName: 'Trafo 1', measurementType,
  };
}

function ts(values: [string, number][], measurementType = 'P', unit = 'MW'): TimeseriesData {
  return {
    component_id: 'C1', component_name: 'Trafo 1', measurement_type: measurementType, unit,
    data: values.map(([timestamp, value]) => ({ timestamp, value })),
  };
}

const H = (h: number) => `2025-01-01T${String(h).padStart(2, '0')}:00:00`;

test('energy integral: constant 10 MW over 2 h → 20 MWh total (trapezoidal)', () => {
  const out = buildEnergyIntegral(src(), ts([[H(0), 10], [H(1), 10], [H(2), 10]]));
  assert.equal(out.unit, 'MWh');
  assert.equal(out.data[0].value, 0);
  assert.equal(out.data[1].value, 10);
  assert.equal(out.data[2].value, 20); // total energy
});

test('energy integral: non-finite sample is skipped, not summed as 0-jump', () => {
  const out = buildEnergyIntegral(src(), ts([[H(0), 10], [H(1), NaN], [H(2), 10]]));
  // The NaN interval contributes nothing; cumulative stays flat then unchanged.
  assert.ok(Number.isFinite(out.data[2].value));
});

test('asset loading: S=50 of rated 100 → 50 %', () => {
  const out = buildLoading(src('C1', 'S'), ts([[H(0), 50]], 'S', 'MVA'), 100);
  assert.equal(out.unit, '%');
  assert.equal(out.data[0].value, 50);
});

test('asset loading: rated 0 is treated as 1 (no divide-by-zero)', () => {
  const out = buildLoading(src('C1', 'S'), ts([[H(0), 50]], 'S', 'MVA'), 0);
  assert.ok(Number.isFinite(out.data[0].value));
});

test('overload duration: sorted descending into a duration curve', () => {
  const out = buildOverloadDuration(src('C1', 'S'), ts([[H(0), 40], [H(1), 120], [H(2), 80]], 'S', 'MVA'), 100);
  // loading% = [40,120,80] → sorted desc [120,80,40]
  assert.deepEqual(out.data.map((p) => p.value), [120, 80, 40]);
  assert.equal(out.data[0].percent, 0);
  assert.equal(out.data[out.data.length - 1].percent, 100);
});

test('losses: in − out aligned on timestamp', () => {
  const inData = ts([[H(0), 100], [H(1), 100]]);
  const outData = ts([[H(0), 90], [H(1), 95]]);
  const out = buildLosses(inData, outData, 'A − B');
  assert.deepEqual(out.data.map((p) => p.value), [10, 5]);
});

test('losses: unmatched timestamps are dropped (no phantom 0 losses)', () => {
  const inData = ts([[H(0), 100], [H(1), 100]]);
  const outData = ts([[H(0), 90]]); // missing H(1)
  const out = buildLosses(inData, outData, 'A − B');
  assert.equal(out.data.length, 1);
  assert.equal(out.data[0].value, 10);
});

test('anomaly score: a flat series has zero z-score', () => {
  const out = buildAnomalyScore(src(), ts([[H(0), 5], [H(1), 5], [H(2), 5], [H(3), 5]]), 4);
  assert.ok(out.data.every((p) => p.value === 0));
});

test('voltage compliance: default band uses 90 % and 110 % of nominal voltage', () => {
  const out = buildVoltageBand(src('C1', 'U'), ts([[H(0), 100]], 'U', 'kV'), 100);
  assert.equal(out.length, 3);
  assert.equal(out[1].component_name, 'Obergrenze (110%)');
  assert.equal(out[1].data[0].value, 110);
  assert.equal(out[2].component_name, 'Untergrenze (90%)');
  assert.equal(out[2].data[0].value, 90);
});

test('voltage compliance: custom min/max percentages define the limit lines', () => {
  const out = buildVoltageBand(src('C1', 'U'), ts([[H(0), 100]], 'U', 'kV'), 100, 95, 108);
  assert.equal(out[1].component_name, 'Obergrenze (108%)');
  assert.equal(out[1].data[0].value, 108);
  assert.equal(out[2].component_name, 'Untergrenze (95%)');
  assert.equal(out[2].data[0].value, 95);
});

test('voltage compliance: swapped percentages are normalized to lower and upper limits', () => {
  const out = buildVoltageBand(src('C1', 'U'), ts([[H(0), 100]], 'U', 'kV'), 100, 112, 88);
  assert.equal(out[1].data[0].value, 112);
  assert.equal(out[2].data[0].value, 88);
});
