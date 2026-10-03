import test from 'node:test';
import assert from 'node:assert/strict';

import { formatVoltage, isPerUnit, unitLabel } from '../voltage.ts';

test('every per-unit spelling is recognised; kV and unknown units are not', () => {
  for (const unit of ['p.u.', 'pu', 'P.U.', ' p.u ', 'p.u']) assert.equal(isPerUnit(unit), true, unit);
  for (const unit of ['kV', 'V', '', null, undefined]) assert.equal(isPerUnit(unit), false, String(unit));
});

test('voltage reads with three decimals in p.u. and one in kV, with sign on request', () => {
  assert.equal(formatVoltage(0.9456, 'p.u.'), '0.946');
  assert.equal(formatVoltage(380, 'kV'), '380.0');
  assert.equal(formatVoltage(0.015, 'p.u.', { signed: true }), '+0.015');
  assert.equal(formatVoltage(-0.04, 'p.u.', { signed: true }), '-0.040');
  assert.equal(formatVoltage(null, 'p.u.'), '–');
  assert.equal(formatVoltage(undefined, 'kV'), '–');
});

test('the unit label is normalised for p.u. and passed through otherwise', () => {
  assert.equal(unitLabel('PU'), 'p.u.');
  assert.equal(unitLabel('kV'), 'kV');
  assert.equal(unitLabel(null), '');
});
