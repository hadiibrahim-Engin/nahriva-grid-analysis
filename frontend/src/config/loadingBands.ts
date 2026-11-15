/**
 * Central definition of the loading severity bands and the thresholds used by
 * the across-scenarios evaluation. The defaults are here; the Limits dialog can
 * change them for this browser (config/overrides.ts). Every component and
 * calculation reads from this file.
 */
import { readOverrides } from './overrides.ts';

export type BandId = 'ok' | 'high' | 'light' | 'clear' | 'severe';

export interface LoadingLimits {
  /** below: uncritical */
  readonly warning: number;
  /** up to and including: warning range; above: overload */
  readonly overload: number;
  /** up to and including: light overload */
  readonly clear: number;
  /** up to and including: clear overload; above: strong overload */
  readonly severe: number;
}

export const DEFAULT_LOADING_LIMITS: LoadingLimits = { warning: 80, overload: 100, clear: 110, severe: 120 };

/** The limits in force: the defaults with the user's changes, as long as they still rise from warning to severe. */
function loadingLimits(): LoadingLimits {
  const changed = readOverrides();
  const chosen = {
    warning: changed.warning ?? DEFAULT_LOADING_LIMITS.warning,
    overload: changed.overload ?? DEFAULT_LOADING_LIMITS.overload,
    clear: changed.clear ?? DEFAULT_LOADING_LIMITS.clear,
    severe: changed.severe ?? DEFAULT_LOADING_LIMITS.severe,
  };
  return chosen.warning < chosen.overload && chosen.overload < chosen.clear && chosen.clear < chosen.severe
    ? chosen : DEFAULT_LOADING_LIMITS;
}

/** Upper limits in % loading. A value is classified by the first limit it does not exceed. */
export const LOADING_LIMITS: LoadingLimits = loadingLimits();

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
