/**
 * Evaluation thresholds changed in the Limits dialog, kept in this browser. They are read once, when the dashboard
 * loads: config/loadingBands.ts and config/assessment.ts lay them over their defaults, so every band, legend and
 * verdict uses the same values. Saving reloads the dashboard. Invalid values fall back to the defaults.
 */

export interface LimitOverrides {
  warning?: number;
  overload?: number;
  clear?: number;
  severe?: number;
  voltageLower?: number;
  voltageUpper?: number;
  voltageMargin?: number;
  thermalReservePp?: number;
  aggravationPp?: number;
}

export const LIMITS_KEY = 'dashboardLimits';
const FIELDS: readonly (keyof LimitOverrides)[] = [
  'warning', 'overload', 'clear', 'severe', 'voltageLower', 'voltageUpper', 'voltageMargin', 'thermalReservePp', 'aggravationPp',
];

/** Only finite, non-negative numbers of known fields survive. */
export function sanitize(value: unknown): LimitOverrides {
  const found: LimitOverrides = {};
  if (!value || typeof value !== 'object') return found;
  for (const field of FIELDS) {
    const number = (value as Record<string, unknown>)[field];
    if (typeof number === 'number' && Number.isFinite(number) && number >= 0) found[field] = number;
  }
  return found;
}

/** The browser's storage; none outside a browser (tests, server rendering). */
const storage = (): Storage | undefined => (typeof window === 'undefined' ? undefined : window.localStorage);

export function readOverrides(): LimitOverrides {
  try {
    const raw = storage()?.getItem(LIMITS_KEY);
    return raw ? sanitize(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function saveOverrides(overrides: LimitOverrides): void {
  storage()?.setItem(LIMITS_KEY, JSON.stringify(sanitize(overrides)));
}

export function clearOverrides(): void {
  storage()?.removeItem(LIMITS_KEY);
}
