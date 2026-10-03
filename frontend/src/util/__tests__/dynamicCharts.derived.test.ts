/**
 * Unit tests for the client-side derived-chart calculations.
 * Run with: npm run test:unit  (Node built-in test runner + TS type-stripping)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAnomalyScore,
  buildVoltageBand,
  type DashboardSeries,
} from '../dynamicCharts.ts';
import type { TimeseriesData } from '../../api/client.ts';

function src(componentId = 'C1', measurementType = 'P'): DashboardSeries {
  return {
    key: `${componentId}-${measurementType}`,
    facilityName: 'F', facilityId: 'F1', componentId, componentName: 'Transformer 1', measurementType,
  };
}

function ts(values: [string, number][], measurementType = 'P', unit = 'MW'): TimeseriesData {
  return {
    component_id: 'C1', component_name: 'Transformer 1', measurement_type: measurementType, unit,
    data: values.map(([timestamp, value]) => ({ timestamp, value })),
  };
}

const H = (h: number) => `2025-01-01T${String(h).padStart(2, '0')}:00:00`;

test('anomaly score: a flat series has zero z-score', () => {
  const out = buildAnomalyScore(src(), ts([[H(0), 5], [H(1), 5], [H(2), 5], [H(3), 5]]), 4);
  assert.ok(out.data.every((p) => p.value === 0));
});

test('voltage compliance: default band uses 90 % and 110 % of nominal voltage', () => {
  const out = buildVoltageBand(src('C1', 'U'), ts([[H(0), 100]], 'U', 'kV'), 100);
  assert.equal(out.length, 3);
  assert.equal(out[1].component_name, 'Upper limit (110%)');
  assert.equal(out[1].data[0].value, 110);
  assert.equal(out[2].component_name, 'Lower limit (90%)');
  assert.equal(out[2].data[0].value, 90);
});

test('voltage compliance: custom min/max percentages define the limit lines', () => {
  const out = buildVoltageBand(src('C1', 'U'), ts([[H(0), 100]], 'U', 'kV'), 100, 95, 108);
  assert.equal(out[1].component_name, 'Upper limit (108%)');
  assert.equal(out[1].data[0].value, 108);
  assert.equal(out[2].component_name, 'Lower limit (95%)');
  assert.equal(out[2].data[0].value, 95);
});

test('voltage compliance: swapped percentages are normalized to lower and upper limits', () => {
  const out = buildVoltageBand(src('C1', 'U'), ts([[H(0), 100]], 'U', 'kV'), 100, 112, 88);
  assert.equal(out[1].data[0].value, 112);
  assert.equal(out[2].data[0].value, 88);
});
