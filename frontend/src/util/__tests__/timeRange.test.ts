import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUtc, inRange, parseUtc, rangeFrom, zoomedRange } from '../timeRange.ts';

test('the address carries the range as UTC minutes, and a time without zone counts as UTC', () => {
  const t = Date.UTC(2026, 0, 5, 6, 30) / 1000;
  assert.equal(formatUtc(t), '2026-01-05T06:30');
  assert.equal(parseUtc('2026-01-05T06:30'), t);
  assert.equal(parseUtc('2026-01-05T07:30+01:00'), t);
  assert.equal(parseUtc('not a time'), null);
  assert.equal(parseUtc(''), null);
});

test('swapped ends are put in order and open ends include everything', () => {
  const range = rangeFrom('2026-01-06T00:00', '2026-01-05T00:00');
  assert.ok(range.from! < range.to!);
  assert.ok(inRange({ from: null, to: null }, 0));
  assert.ok(!inRange(range, range.to! + 60));
});

test('a zoom is read from slider and inside events, and a full view is no range', () => {
  assert.deepEqual(zoomedRange({ start: 25, end: 50 }, 0, 400), { from: 100, to: 200 });
  assert.deepEqual(zoomedRange({ batch: [{ start: 0, end: 10 }] }, 1000, 2000), { from: 1000, to: 1100 });
  assert.equal(zoomedRange({ start: 0, end: 100 }, 0, 400), null);
  assert.equal(zoomedRange({}, 0, 400), null);
});
