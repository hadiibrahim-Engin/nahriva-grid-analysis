/**
 * The time range of the time courses: epoch seconds (UTC), each end open when null. It travels in the address as
 * ?from=…&to=… (ISO, UTC, minutes), so a link opens the same span.
 */
export interface TimeRange {
  from: number | null;
  to: number | null;
}

export const WHOLE_PERIOD: TimeRange = { from: null, to: null };

/** Epoch seconds of an ISO time; a time without zone counts as UTC. Null when empty or not a time. */
export function parseUtc(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** The ISO form of an epoch time in UTC to the minute, as a datetime-local input and the address take it. */
export function formatUtc(t: number | null): string {
  return t === null ? '' : new Date(t * 1000).toISOString().slice(0, 16);
}

/** A range from the two address values; ends that are swapped are put in order. */
export function rangeFrom(from: string | null, to: string | null): TimeRange {
  const a = parseUtc(from);
  const b = parseUtc(to);
  return a !== null && b !== null && b < a ? { from: b, to: a } : { from: a, to: b };
}

export const isWhole = (range: TimeRange) => range.from === null && range.to === null;

export const inRange = (range: TimeRange, t: number) => (range.from === null || t >= range.from) && (range.to === null || t <= range.to);

/**
 * The span an ECharts dataZoom shows, from its start/end percentages over the course from `first` to `last`
 * (a slider reports them directly, an inside zoom in `batch`). Null when it shows (almost) everything.
 */
export function zoomedRange(params: unknown, first: number, last: number): TimeRange | null {
  const event = params as { start?: number; end?: number; batch?: { start?: number; end?: number }[] };
  const zoom = event.batch?.[0] ?? event;
  if (typeof zoom.start !== 'number' || typeof zoom.end !== 'number') return null;
  if (zoom.start <= 0.5 && zoom.end >= 99.5) return null;
  const at = (pct: number) => Math.round(first + ((last - first) * pct) / 100);
  return { from: at(zoom.start), to: at(zoom.end) };
}
