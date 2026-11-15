import { useSyncExternalStore } from 'react';
import { readParam, writeParam } from '../util/shareLink';
import { formatUtc, rangeFrom, WHOLE_PERIOD, type TimeRange } from '../util/timeRange';

const listeners = new Set<() => void>();
let current: { key: string; range: TimeRange } | null = null;

function snapshot(): TimeRange {
  const from = readParam('from');
  const to = readParam('to');
  const key = `${from}|${to}`;
  if (current?.key !== key) current = { key, range: rangeFrom(from, to) };
  return current.range;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Choose the time range of every time course (and record it in the address); WHOLE_PERIOD clears it. */
export function setTimeRange(range: TimeRange): void {
  writeParam('from', range.from === null ? null : formatUtc(range.from));
  writeParam('to', range.to === null ? null : formatUtc(range.to));
  listeners.forEach((listener) => listener());
}

/** The time range of the time courses, shared by every view that shows one. */
export function useTimeRange(): TimeRange {
  return useSyncExternalStore(subscribe, snapshot, () => WHOLE_PERIOD);
}
