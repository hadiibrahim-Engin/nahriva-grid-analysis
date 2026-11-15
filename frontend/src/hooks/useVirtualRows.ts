import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/** Up to this many rows a table renders all of them; above, only the rows around the visible part. */
export const VIRTUAL_MIN_ROWS = 60;
/** Extra height rendered above and below the visible part, so fast scrolling does not show empty space. */
const OVERSCAN_PX = 800;
/** The window moves in steps of this many rows, so scrolling re-renders the table seldom. */
const STEP = 10;
/** Rows rendered before anything is measured (and while the table is off screen). */
const INITIAL_ROWS = 40;

export interface RowWindow {
  /** Callback ref for the <tbody>. */
  bodyRef: (element: HTMLTableSectionElement | null) => void;
  /** Rows [start, end) are rendered; every rendered row carries data-row={its key}. */
  start: number;
  end: number;
  /** Heights of the spacer rows above and below (0: no spacer row). */
  padTop: number;
  padBottom: number;
  /** Whether only a window is rendered. */
  virtual: boolean;
}

/**
 * Renders a long table body in a window around the visible part. Rows are identified by `keys` (in display order);
 * their heights are measured as they are rendered and estimated (`estimate` px, including the table's row spacing)
 * until then. The page scrolls in a container of its own, so every scroll on the page is listened to.
 */
export function useVirtualRows(keys: readonly string[], estimate: number): RowWindow {
  const count = keys.length;
  const virtual = count > VIRTUAL_MIN_ROWS;
  const body = useRef<HTMLTableSectionElement | null>(null);
  // Measured height per row key (distance to the next row) and the distance the table adds between rows.
  const [measured, setMeasured] = useState(() => ({ heights: new Map<string, number>(), spacing: 0 }));
  const [range, setRange] = useState({ start: 0, end: INITIAL_ROWS });

  // Top of every row in body coordinates, plus the total height at the end.
  const offsets = useMemo(() => {
    const result = new Array<number>(count + 1);
    result[0] = 0;
    for (let i = 0; i < count; i += 1) result[i + 1] = result[i] + (measured.heights.get(keys[i]) ?? estimate);
    return result;
  }, [keys, count, estimate, measured]);

  /** True when the table is near the visible part of the window (cheap: the scroll wrapper is never skipped). */
  const nearView = useCallback(() => {
    const wrapper = body.current?.closest('table')?.parentElement;
    if (!wrapper) return false;
    const rect = wrapper.getBoundingClientRect();
    return rect.bottom > -OVERSCAN_PX && rect.top < window.innerHeight + OVERSCAN_PX;
  }, []);

  const update = useCallback(() => {
    const element = body.current;
    if (!virtual || !element || !nearView()) return;
    const top = -element.getBoundingClientRect().top - OVERSCAN_PX;
    const bottom = top + window.innerHeight + 2 * OVERSCAN_PX;
    let lo = 0, hi = count;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid + 1] <= top) lo = mid + 1; else hi = mid; }
    const first = lo;
    let last = first;
    while (last < count && offsets[last] < bottom) last += 1;
    const start = Math.max(0, Math.floor(first / STEP) * STEP);
    const end = Math.min(count, Math.max(start + STEP, Math.ceil(last / STEP) * STEP));
    setRange((current) => (current.start === start && current.end === end ? current : { start, end }));
  }, [virtual, count, offsets, nearView]);

  // Follow every scroll of the page (capture: the page scrolls in an element, not in the window) and its size.
  useEffect(() => {
    if (!virtual) return;
    let frame = 0;
    const schedule = () => { if (frame === 0) frame = requestAnimationFrame(() => { frame = 0; update(); }); };
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [virtual, update]);

  // Measure the rendered rows: the distance from one row to the next is its height in the table.
  useLayoutEffect(() => {
    const element = body.current;
    if (!virtual || !element || !nearView()) return;
    const rows = Array.from(element.querySelectorAll<HTMLTableRowElement>(':scope > tr[data-row]'));
    if (rows.length === 0) return;
    const rects = rows.map((row) => row.getBoundingClientRect());
    const spacing = rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : measured.spacing;
    let heights: Map<string, number> | null = null;
    rows.forEach((row, i) => {
      const pitch = i + 1 < rects.length ? rects[i + 1].top - rects[i].top : rects[i].height + spacing;
      const key = row.dataset.row!;
      if (Math.abs((measured.heights.get(key) ?? -1) - pitch) > 0.5) {
        heights ??= new Map(measured.heights);
        heights.set(key, pitch);
      }
    });
    if (heights || Math.abs(spacing - measured.spacing) > 0.5) setMeasured({ heights: heights ?? measured.heights, spacing });
  }, [virtual, nearView, range, keys, measured]);

  const bodyRef = useCallback((element: HTMLTableSectionElement | null) => { body.current = element; }, []);
  if (!virtual) return { bodyRef, start: 0, end: count, padTop: 0, padBottom: 0, virtual };
  const start = Math.min(range.start, Math.max(0, count - 1));
  const end = Math.min(Math.max(range.end, start + 1), count);
  // A spacer row gets the table's row spacing too; it replaces whole rows, spacing included.
  const pad = (height: number) => (height > 0 ? Math.max(0, height - measured.spacing) : 0);
  return { bodyRef, start, end, padTop: pad(offsets[start]), padBottom: pad(offsets[count] - offsets[end]), virtual };
}
