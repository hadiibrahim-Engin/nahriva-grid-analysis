import test from 'node:test';
import assert from 'node:assert/strict';

import { bandOf, excessOf } from '../../config/loadingBands.ts';
import {
  analyse,
  fmtPp,
  lineStats,
  summarySections,
  SUMMARY_IDS,
  type AcrossCell,
  type AcrossData,
  type AcrossLine,
  type AcrossScenario,
} from '../acrossScenarios.ts';

const scenario = (id: string): AcrossScenario => ({ id, name: id, outages: [], outaged_element_ids: [], has_lodf: true });
const cell = (
  value: number | null,
  delta: number | null = 0,
  lodf: number | null = null,
  outaged = false,
  hours: number[] | null = value !== null && value > 100 ? [6, 0, 0] : [0, 0, 0],
): AcrossCell =>
  ({ outaged, value, window_base: value === null || delta === null ? null : value - delta, delta, lodf, hours_over: outaged ? null : hours });
const line = (id: string, base: number, cells: Record<string, AcrossCell>): AcrossLine =>
  ({ id, name: id, class_name: 'ElmLne', type: 'line', base, cells });
const scenarios = ['s1', 's2', 's3', 's4'].map(scenario);

test('band limits: 80 and 100 are inclusive upper limits of the lower band', () => {
  assert.equal(bandOf(79.9).id, 'ok');
  assert.equal(bandOf(80).id, 'high');
  assert.equal(bandOf(100).id, 'high');
  assert.equal(bandOf(100.1).id, 'light');
  assert.equal(bandOf(110).id, 'light');
  assert.equal(bandOf(110.1).id, 'clear');
  assert.equal(bandOf(120).id, 'clear');
  assert.equal(bandOf(120.1).id, 'severe');
});

test('excess: 96 % → 0 pp, 105 % → 5 pp, 118 % → 18 pp', () => {
  assert.equal(excessOf(96), 0);
  assert.equal(excessOf(105), 5);
  assert.equal(excessOf(118), 18);
});

test('counts, rate and excess statistics', () => {
  const s = lineStats(line('L', 70, {
    s1: cell(96), s2: cell(105, 10), s3: cell(118, 30), s4: cell(125, 40),
  }), scenarios);
  assert.deepEqual([s.n100, s.n110, s.n120], [3, 2, 1]);
  assert.equal(s.scenarioShare, 0.75);
  assert.equal(s.maxExcess, 25);
  assert.equal(s.sumExcess, 48);
  assert.equal(s.meanExcess, 16);
  assert.equal(s.max, 125);
  assert.equal(s.maxScenarioId, 's4');
  assert.equal(s.band, 'severe');
  assert.equal(s.pattern, 'frequent-strong');
});

test('switched-off scenario counts in the denominator but never as overload', () => {
  const s = lineStats(line('L', 70, {
    s1: cell(null, null, null, true), s2: cell(105), s3: cell(60), s4: cell(60),
  }), scenarios);
  assert.equal(s.inService, 3);
  assert.equal(s.n100, 1);
  assert.equal(s.scenarioShare, 0.25);
  assert.equal(s.min, 60);
});

test('patterns distinguish the evaluation cases', () => {
  const single = lineStats(line('a', 60, { s1: cell(128, 60), s2: cell(61), s3: cell(60), s4: cell(60) }), scenarios);
  assert.equal(single.pattern, 'single-extreme');
  const light = lineStats(line('b', 90, { s1: cell(102), s2: cell(104), s3: cell(88), s4: cell(101) }), scenarios);
  assert.equal(light.pattern, 'frequent-light');
  const change = lineStats(line('c', 25, { s1: cell(54, 29), s2: cell(26, 1), s3: cell(25), s4: cell(25) }), scenarios);
  assert.equal(change.pattern, 'strong-change');
  const constant = lineStats(line('d', 88, { s1: cell(91, 3), s2: cell(92, 4), s3: cell(89, 1), s4: cell(88) }), scenarios);
  assert.equal(constant.pattern, 'high-constant');
  const lodf = lineStats(line('e', 50, { s1: cell(70, 20, 0.5), s2: cell(51, 1, 0.01), s3: cell(50), s4: cell(50) }), scenarios);
  assert.equal(lodf.pattern, 'lodf-driven');
});

test('kpis name the line and scenario of each extreme', () => {
  const data: AcrossData = {
    scenarios,
    has_lodf: true,
    period_hours: 168,
    limits: [100, 110, 120],
    lines: [
      line('L204', 63, { s1: cell(71, 8, 0.1), s2: cell(84, 21, 0.2), s3: cell(128, 65, 0.61), s4: cell(76, 13, 0.1) }),
      line('L118', 78, { s1: cell(81, 3), s2: cell(112, 34, 0.3), s3: cell(91, 13), s4: cell(84, 6) }),
    ],
  };
  const { kpis, scenarios: stats } = analyse(data);
  assert.equal(kpis.maxLoading?.value, 128);
  assert.equal(kpis.maxLoading?.line.id, 'L204');
  assert.equal(kpis.maxLoading?.scenarioId, 's3');
  assert.equal(kpis.maxLodf?.value, 0.61);
  assert.equal(kpis.maxChange?.value, 65);
  assert.equal(kpis.scenariosOverloaded, 2);
  assert.equal(kpis.linesOverloaded, 2);
  assert.equal(kpis.linesRecurring, 0);
  assert.equal(kpis.criticalScenario?.scenario.id, 's3');
  assert.deepEqual(stats[2].counts, { ok: 0, high: 1, light: 0, clear: 0, severe: 1 });
});

test('overload rate relates to the simulation period, not to the number of scenarios', () => {
  const s = lineStats(line('L', 70, {
    s1: cell(105, 10, null, false, [12, 3, 0]),
    s2: cell(112, 12, null, false, [24, 6, 0]),
    s3: cell(60),
    s4: cell(60),
  }), scenarios, 168);
  assert.equal(s.overloadHours, 24);
  assert.deepEqual(s.overloadHoursBands, [24, 6, 0]);
  assert.equal(s.overloadScenarioId, 's2');
  assert.ok(Math.abs(s.overloadShare - 24 / 168) < 1e-12);
  assert.equal(s.scenarioShare, 0.5); // still available for "overloaded in many scenarios"
});

test('kpi: longest overload names hours, share of the period, line and scenario', () => {
  const data: AcrossData = {
    scenarios, has_lodf: false, period_hours: 100, limits: [100, 110, 120],
    lines: [line('A', 80, { s1: cell(105, 5, null, false, [10, 0, 0]), s2: cell(70), s3: cell(70), s4: cell(70) }),
            line('B', 80, { s1: cell(70), s2: cell(130, 50, null, false, [25, 20, 10]), s3: cell(70), s4: cell(70) })],
  };
  const { kpis, scenarios: stats } = analyse(data);
  assert.equal(kpis.longestOverload?.line.id, 'B');
  assert.equal(kpis.longestOverload?.value, 25);
  assert.equal(kpis.longestOverload?.share, 0.25);
  assert.equal(kpis.longestOverload?.scenarioId, 's2');
  assert.equal(stats[1].longestOverloadHours, 25);
});

test('pp formatting always carries the unit and a sign', () => {
  assert.equal(fmtPp(42), '+42.0 pp');
  assert.equal(fmtPp(-18), '−18.0 pp');
  assert.equal(fmtPp(0), '0.0 pp');
});

test('navigation outline follows the reading order of an outage assessment, with counts', () => {
  const data: AcrossData = {
    scenarios, has_lodf: false, period_hours: 168, limits: [100, 110, 120],
    lines: [line('A', 80, { s1: cell(70), s2: cell(70), s3: cell(70), s4: cell(70) })],
  };
  const sections = summarySections(analyse(data), 2);
  const expected: string[] = [
    SUMMARY_IDS.kpis, SUMMARY_IDS.overview, SUMMARY_IDS.profile, SUMMARY_IDS.details,
    SUMMARY_IDS.voltage, SUMMARY_IDS.heatmap, SUMMARY_IDS.charts, SUMMARY_IDS.table,
  ];
  // Further sections may be added; the listed ones keep their relative reading order.
  assert.deepEqual(sections.map((s) => s.id).filter((id) => expected.includes(id)), expected);
  assert.equal(new Set(sections.map((s) => s.id)).size, sections.length);
  assert.equal(sections.find((s) => s.id === SUMMARY_IDS.overview)?.count, 4);
  assert.equal(sections.find((s) => s.id === SUMMARY_IDS.voltage)?.count, 2);
  // The verdict comes before any comparison across the scenarios.
  const ids = sections.map((s) => s.id);
  assert.ok(ids.indexOf(SUMMARY_IDS.overview) < ids.indexOf(SUMMARY_IDS.heatmap));
  assert.ok(!summarySections(analyse(data), 0).some((s) => s.id === SUMMARY_IDS.voltage));
});
