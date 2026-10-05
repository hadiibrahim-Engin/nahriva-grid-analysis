import test from 'node:test';
import assert from 'node:assert/strict';

import { lodfStatus } from '../lodfStatus.ts';

test('nothing to explain when one scenario shown has an LODF', () => {
  assert.equal(lodfStatus([{ name: 'A', has_lodf: false, lodf_note: 'x' }, { name: 'B', has_lodf: true }]), null);
  assert.equal(lodfStatus([]), null);
});

test('the reasons PowerFactory gave are shown per scenario', () => {
  const status = lodfStatus([
    { name: 'NE01 load connection outage', has_lodf: false, lodf_note: "LODF 'NE01 load connection outage': CB2 is no contingency of the Contingency Analysis." },
    { name: 'NE01-NE02 demand transfer', has_lodf: false, lodf_note: "LODF 'NE01-NE02 demand transfer': the outage switches no line, transformer or coupler; no LODF." },
  ]);
  assert.equal(status?.short, 'no LODF');
  assert.equal(status?.text, 'None of the scenarios shown has an LODF. NE01 load connection outage: CB2 is no contingency of the Contingency Analysis. · NE01-NE02 demand transfer: the outage switches no line, transformer or coupler; no LODF.');
});

test('without any reason the LODF step did not write anything: point to the PowerFactory output', () => {
  const status = lodfStatus([{ name: 'A', has_lodf: false }, { name: 'B', has_lodf: false, lodf_note: null }]);
  assert.equal(status?.short, 'not calculated');
  assert.match(status?.text ?? '', /step 4\/5/);
});
