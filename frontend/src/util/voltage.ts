/** Voltage units: results arrive in p.u. (3 decimals) or in kV (1 decimal). One place decides how they read. */

export const isPerUnit = (unit: string | null | undefined): boolean => /^p\.?u\.?$/i.test((unit ?? '').trim());

/** The unit as written next to a value: 'p.u.' for any per-unit spelling, the unit itself otherwise. */
export const unitLabel = (unit: string | null | undefined): string => (isPerUnit(unit) ? 'p.u.' : (unit ?? ''));

// Built once: toLocaleString with options builds a new formatter on every call, and the voltage matrix
// formats several values per busbar and scenario on every render.
const PU_FORMAT = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const KV_FORMAT = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** A voltage value in German number format; '–' when there is none; optionally with an explicit '+' sign. */
export function formatVoltage(value: number | null | undefined, unit: string | null | undefined, options: { signed?: boolean } = {}): string {
  if (value === null || value === undefined) return '–';
  const text = (isPerUnit(unit) ? PU_FORMAT : KV_FORMAT).format(value);
  return options.signed && value > 0 ? `+${text}` : text;
}
