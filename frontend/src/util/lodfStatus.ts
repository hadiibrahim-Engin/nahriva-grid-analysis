/** Why the dashboard shows no LODF, instead of a bare "not calculated". */

interface WithLodf {
  name: string;
  has_lodf: boolean;
  lodf_note?: string | null;
}

export interface LodfStatus {
  /** One or two words for a table cell or a key figure. */
  short: string;
  /** The full explanation for an empty chart. */
  text: string;
}

/** The reasons the script stored start with "LODF '<scenario>': "; the scenario is named separately here. */
const reason = (note: string) => note.replace(/^LODF '[^']*': /, '');

/** null when at least one scenario shown has an LODF. */
export function lodfStatus(scenarios: WithLodf[]): LodfStatus | null {
  if (scenarios.length === 0 || scenarios.some((scenario) => scenario.has_lodf)) return null;
  const explained = scenarios.filter((scenario) => scenario.lodf_note);
  if (explained.length === 0) {
    return {
      short: 'not calculated',
      text: "PowerFactory wrote no LODF for these scenarios. Its output, step 4/5 (LODF), says why; typically the Study Case has no 'Sensitivities / Distribution Factors' command or no Contingency Analysis.",
    };
  }
  const listed = explained.map((scenario) => `${scenario.name}: ${reason(scenario.lodf_note!)}`).join(' · ');
  const rest = scenarios.length - explained.length;
  return {
    short: 'no LODF',
    text: `None of the scenarios shown has an LODF. ${listed}${rest ? ` · ${rest} more without a reason (not calculated)` : ''}`,
  };
}
