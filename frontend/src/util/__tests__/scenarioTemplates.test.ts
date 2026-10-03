import test from 'node:test';
import assert from 'node:assert/strict';

import { CATEGORY_ORDER, CHART_TEMPLATES } from '../../components/charts/chartTemplates.ts';
import { filterByEquipment } from '../outageAssessment.ts';

const scenario = CHART_TEMPLATES.filter((t) => t.scenarioLevel);

test('the scenario evaluation charts are offered in "Add chart" and need no signals', () => {
  assert.deepEqual(scenario.map((t) => t.kind).sort(), ['acrossDelta', 'acrossLoading', 'acrossLodf', 'acrossTime', 'acrossVoltage', 'acrossVoltageDelta']);
  for (const template of scenario) {
    assert.equal(template.arity, 'none');
    assert.deepEqual(template.measurements, []);
    assert.equal(template.componentLevel, undefined);
    assert.equal(template.needsScenarioOptions, true);
    assert.equal(template.category, 'scenarioEvaluation');
  }
  assert.equal(CATEGORY_ORDER[0], 'scenarioEvaluation');
});

test('template ids are unique and every category is listed in the picker order', () => {
  const ids = CHART_TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const template of CHART_TEMPLATES) assert.ok(CATEGORY_ORDER.includes(template.category), template.id);
});

test('equipment filter keeps lines, transformers or everything', () => {
  const items = [{ type: 'line' }, { type: 'transformer' }, { type: 'line' }, { type: 'coupler' }];
  assert.equal(filterByEquipment(items, 'all').length, 4);
  assert.equal(filterByEquipment(items, 'line').length, 2);
  assert.equal(filterByEquipment(items, 'transformer').length, 1);
});

test('every template works with loading and voltage data only', () => {
  for (const t of CHART_TEMPLATES) {
    assert.ok(t.measurements.every((m) => m === 'L' || m === 'U'), `${t.id} needs ${t.measurements.join('/')}`);
  }
  // The correlation charts stay.
  const ids = new Set(CHART_TEMPLATES.map((t) => t.id));
  for (const id of ['correlation-scatter', 'correlation-scatter-3d', 'correlation-scatter-3d-view', 'correlation-matrix']) assert.ok(ids.has(id), id);
});
