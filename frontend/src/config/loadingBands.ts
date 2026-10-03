/**
 * Central definition of the loading severity bands and the thresholds used by
 * the across-scenarios evaluation. Change values here only; every component and
 * calculation reads from this file.
 */

export type BandId = 'ok' | 'high' | 'light' | 'clear' | 'severe';

/** Upper limits in % loading. A value is classified by the first limit it does not exceed. */
export const LOADING_LIMITS = {
  /** below: uncritical */
  warning: 80,
  /** up to and including: warning range; above: overload */
  overload: 100,
  /** up to and including: light overload */
  clear: 110,
  /** up to and including: clear overload; above: strong overload */
  severe: 120,
} as const;

export interface LoadingBand {
  id: BandId;
  label: string;
  /** Range as shown in legends. */
  range: string;
}

const L = LOADING_LIMITS;
export const LOADING_BANDS: readonly LoadingBand[] = [
  { id: 'ok', label: 'Uncritical', range: `< ${L.warning} %` },
  { id: 'high', label: 'High loading', range: `${L.warning}–${L.overload} %` },
  { id: 'light', label: 'Light overload', range: `${L.overload}–${L.clear} %` },
  { id: 'clear', label: 'Clear overload', range: `${L.clear}–${L.severe} %` },
  { id: 'severe', label: 'Strong overload', range: `> ${L.severe} %` },
];

export const BAND_ORDER: readonly BandId[] = LOADING_BANDS.map((band) => band.id);

export function bandOf(value: number): LoadingBand {
  const id: BandId =
    value < L.warning ? 'ok'
    : value <= L.overload ? 'high'
    : value <= L.clear ? 'light'
    : value <= L.severe ? 'clear'
    : 'severe';
  return LOADING_BANDS[BAND_ORDER.indexOf(id)];
}

export function bandIndex(id: BandId): number {
  return BAND_ORDER.indexOf(id);
}

/** Overload excess in percentage points: max(loading − 100 %, 0). */
export function excessOf(value: number): number {
  return Math.max(value - LOADING_LIMITS.overload, 0);
}

/** Thresholds for the other evaluation metrics. */
export const ANALYSIS = {
  /** A line counts as repeatedly overloaded from this many scenarios above 100 %. */
  recurringMinScenarios: 2,
  /** Share of all scenarios with an overload from which a line counts as overloaded in many scenarios. */
  frequentScenarioShare: 0.5,
  /** |LODF| from which a factor is highlighted. */
  lodfNotable: 0.3,
  /** Change of loading between REF and scenario (pp) from which a change is called strong. */
  deltaStrongPp: 20,
  /** A line counts as affected by a scenario from this change of loading (pp). */
  affectedDeltaPp: 10,
  /** Spread across scenarios (pp) below which a line is called scenario independent. */
  spreadIndependentPp: 5,
  /** Lines shown in the heatmap before the user asks for more. */
  heatmapDefaultRows: 12,
  /** Weights of the "conspicuousness" ranking used for heatmap selection and default table order. */
  priorityWeights: {
    maxExcess: 3,
    sumExcess: 1,
    /** Overload time as share of the simulation period (0..1). */
    overloadTime: 60,
    highLoading: 1,
    absDelta: 0.8,
    lodf: 30,
  },
} as const;

/** CSS colour of a band; the hues are defined per theme in index.css (.across-scope). */
export const bandVar = (id: BandId): string => `var(--ab-${id})`;
