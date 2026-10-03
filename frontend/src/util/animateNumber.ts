/**
 * Smoothly animate a numeric value from `from` to `to` over `durationMs`,
 * formatting each intermediate frame with the provided `format` function.
 *
 * Used by KPI tiles to ramp the displayed number when the underlying
 * value changes (e.g. user picks a new date range) — gives a sense of
 * data freshness without a jarring snap.
 *
 * The hook returns the live formatted string; consumers just render it.
 * Cancellation is automatic on unmount / target change.
 */
import { useEffect, useRef, useState } from 'react';

type Formatter = (n: number) => string;

const DEFAULT_DURATION_MS = 600;

/** Ease-out cubic — matches the "decelerate" feel of the rest of the UI. */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function useAnimatedNumber(
  target: number | null | undefined,
  format: Formatter,
  durationMs: number = DEFAULT_DURATION_MS,
): string {
  // The visible value driven by rAF. Starts at `target` so the very
  // first render doesn't ramp from 0 (would look like a glitch).
  const [display, setDisplay] = useState<number | null>(
    target == null || !Number.isFinite(target) ? null : target,
  );

  // Track what we last animated to, so re-renders without a value
  // change don't re-trigger the ramp.
  const lastTargetRef = useRef<number | null>(
    target == null || !Number.isFinite(target) ? null : target,
  );
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    // Handle null / undefined / NaN targets by snapping the display.
    if (target == null || !Number.isFinite(target)) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      lastTargetRef.current = null;
      setDisplay(null);
      return;
    }

    const from = lastTargetRef.current ?? target;
    const to = target;
    lastTargetRef.current = to;

    // No animation if the target didn't actually change.
    if (from === to) {
      setDisplay(to);
      return;
    }

    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / durationMs);
      const eased = easeOutCubic(t);
      const current = from + (to - from) * eased;
      setDisplay(current);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [target, durationMs]);

  if (display == null) return format(0);
  return format(display);
}
