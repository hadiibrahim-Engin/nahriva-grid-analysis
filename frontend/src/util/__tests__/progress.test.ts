import test from 'node:test';
import assert from 'node:assert/strict';

import { STALE_HOURS, progressView, type PfProgress } from '../progress.ts';

const at = (iso: string) => new Date(iso).getTime();
const running = (over: Partial<PfProgress> = {}): PfProgress => ({
  state: 'running', step: 'STEP 2/5 · Reference', detail: '', current: null, total: null,
  started_at: '2026-10-05T10:00:00Z', updated_at: '2026-10-05T10:05:00Z', ...over,
});

test('nothing to say before a run and after it finished: the results are there', () => {
  assert.equal(progressView(null), null);
  assert.equal(progressView(undefined), null);
  assert.equal(progressView(running({ state: 'finished' })), null);
});

test('while no scenario is calculated the banner names the step and has no bar', () => {
  const view = progressView(running(), at('2026-10-05T10:06:00Z'));
  assert.equal(view?.tone, 'running');
  assert.match(view?.text ?? '', /PowerFactory is working · STEP 2\/5 · Reference/);
  assert.equal(view?.fraction, null);
});

test('during the scenarios it names the scenario and shows how far the run is', () => {
  const view = progressView(running({ step: 'STEP 5/5 · Scenarios', detail: 'Scenario 3/20 · NE_L1', current: 3, total: 20 }), at('2026-10-05T10:06:00Z'));
  assert.match(view?.text ?? '', /STEP 5\/5 · Scenarios · Scenario 3\/20 · NE_L1/);
  assert.equal(view?.fraction, 0.15);
});

test('a failed or stopped run says so, with the reason', () => {
  assert.deepEqual(progressView(running({ state: 'failed', detail: 'ComStatsim requires an ElmRes' })), {
    tone: 'failed', text: 'PowerFactory stopped with an error · ComStatsim requires an ElmRes', fraction: null,
  });
  assert.equal(progressView(running({ state: 'stopped', detail: 'Scenarios saved before stay in the database.' }))?.tone, 'stopped');
});

test('a run that has not reported for hours is called stale, not running', () => {
  const quiet = at('2026-10-05T10:05:00Z') + (STALE_HOURS + 1) * 3600_000;
  const view = progressView(running(), quiet);
  assert.equal(view?.tone, 'stale');
  assert.match(view?.text ?? '', /has not reported since/);
  assert.equal(progressView(running(), at('2026-10-05T10:05:00Z') + (STALE_HOURS - 1) * 3600_000)?.tone, 'running');
});
