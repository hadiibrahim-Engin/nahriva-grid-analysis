import test from 'node:test';
import assert from 'node:assert/strict';

import { runProblems, type ResultScenario } from '../resultProvenance.ts';

const scenario = (name: string, runs: ResultScenario['runs']): ResultScenario => ({ id: name, name, runs });

test('only runs that are not completed are listed, with the reason PowerFactory gave', () => {
  const found = runProblems([
    scenario('A', [{ run_id: 'r1', kind: 'REF' }, { run_id: 'r2', kind: 'OUTAGE', status: 'completed' }]),
    scenario('B', [{ run_id: 'r1', kind: 'REF', status: 'completed' }, { run_id: 'r3', kind: 'OUTAGE', status: 'not_converged', note: 'error code 1' }]),
    scenario('C', [{ run_id: 'r4', kind: 'OUTAGE', status: 'incomplete', note: '3 of 8784 time points' }]),
  ]);
  assert.deepEqual(found, [
    { scenario: 'B', kind: 'OUTAGE', state: 'did not converge', note: 'error code 1' },
    { scenario: 'C', kind: 'OUTAGE', state: 'has time points without a result', note: '3 of 8784 time points' },
  ]);
});
