/**
 * Criteria of the outage assessment. Change values here only.
 *
 * A scenario is judged on all evaluated equipment: branches by thermal loading
 * (lines, transformers) and busbars by voltage. The decisive question is whether a
 * violation is *caused* by the outage or was already there in the reference run.
 */
export const ASSESSMENT = {
  /** Loading increase (pp) against REF from which an existing overload counts as aggravated. */
  aggravationPp: 2,
  /** Remaining thermal reserve (pp below 100 %) under which a branch counts as heavily utilised after the outage. */
  thermalReservePp: 5,
  /**
   * Permissible voltage band in p.u. for the busbars. Applies to every voltage result stored in p.u.;
   * results in other units (kV) are judged against the limits stored with them.
   */
  voltageBandPu: { lower: 0.9, upper: 1.1 },
  /** Distance to a voltage limit (p.u.) below which a busbar counts as close to the limit. */
  voltageMarginPu: 0.02,
  /** Voltage change (p.u.) beyond the REF range from which an existing violation counts as aggravated. */
  voltageAggravationPu: 0.002,
} as const;

export type Verdict = 'permissible' | 'conditional' | 'not-permissible' | 'unknown';

export const VERDICTS: Record<Verdict, { label: string; glyph: string; description: string }> = {
  permissible: {
    label: 'Permissible',
    glyph: '✓',
    description: 'No violation caused by the outage and no approach to limits.',
  },
  conditional: {
    label: 'Conditionally permissible',
    glyph: '!',
    description: 'No new violation, but pre-existing load above the limits, a small thermal reserve, the warning range or a small voltage reserve.',
  },
  'not-permissible': {
    label: 'Not permissible',
    glyph: '✕',
    description: 'Overload or voltage violation caused or aggravated by the outage.',
  },
  unknown: {
    label: 'Not assessable',
    glyph: '?',
    description: 'No result values for this scenario.',
  },
};
