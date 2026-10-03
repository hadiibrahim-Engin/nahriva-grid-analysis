import assert from 'node:assert/strict';
import test from 'node:test';
import { isSynthetic, provenancePeriod, resultContexts } from '../resultProvenance.ts';

test('legacy results never inherit version, model or study from the current catalog', () => {
  const [context] = resultContexts([{ id: 'old', name: 'Old', project: 'Original model', study_case: 'Original study', runs: [{ run_id: 'r', kind: 'REF', source: 'PowerFactory' }] }], { project: 'New model', study_case: 'New study', powerfactory_version: '26.0.3' });
  assert.equal(context.provenance.project, 'Original model');
  assert.equal(context.provenance.study_case, 'Original study');
  assert.equal(context.provenance.powerfactory_version, undefined);
});

test('different calculation versions stay separate and matching contexts share a count', () => {
  const scenarios = ['26.0.3', '26.0.3', '25.0.1'].map((version, index) => ({ id: String(index), name: 'Scenario', runs: [], provenance: { project: 'Model', study_case: 'Study', powerfactory_version: version } }));
  const contexts = resultContexts(scenarios, null);
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].count, 2);
  assert.equal(contexts[1].count, 1);
});

test('synthetic legacy runs remain clearly distinct from actual PowerFactory results', () => {
  const [context] = resultContexts([{ id: 'dummy', name: 'Dummy', runs: [{ run_id: 'r', kind: 'REF', source: 'Dummy QDS (synthetic)' }] }], null);
  assert.equal(isSynthetic(context.provenance), true);
  assert.equal(isSynthetic({ data_source: 'PowerFactory' }), false);
  assert.equal(provenancePeriod([null, null]), 'Not recorded');
  assert.match(provenancePeriod([1769817600, 1769821200]), /UTC$/);
});
