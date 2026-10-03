/**
 * Criteria of the outage (Freischaltung) assessment. Change values here only.
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
    label: 'Zulässig',
    glyph: '✓',
    description: 'Keine Verletzung durch die Freischaltung, keine Annäherung an Grenzen.',
  },
  conditional: {
    label: 'Bedingt zulässig',
    glyph: '!',
    description: 'Keine neue Verletzung, aber Vorbelastung über den Grenzen, geringe thermische Reserve, Warnbereich oder geringe Spannungsreserve.',
  },
  'not-permissible': {
    label: 'Nicht zulässig',
    glyph: '✕',
    description: 'Überlastung oder Spannungsverletzung durch die Freischaltung verursacht oder verschärft.',
  },
  unknown: {
    label: 'Nicht bewertbar',
    glyph: '?',
    description: 'Keine Ergebniswerte für dieses Szenario.',
  },
};
