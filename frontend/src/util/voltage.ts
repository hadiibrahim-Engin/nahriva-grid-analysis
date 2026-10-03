/** Voltage units: results arrive in p.u. (3 decimals) or in kV (1 decimal). One place decides how they read. */

export const isPerUnit = (unit: string | null | undefined): boolean => /^p\.?u\.?$/i.test((unit ?? '').trim());

/** The unit as written next to a value: 'p.u.' for any per-unit spelling, the unit itself otherwise. */
export const unitLabel = (unit: string | null | undefined): string => (isPerUnit(unit) ? 'p.u.' : (unit ?? ''));

/** A voltage value in German number format; '–' when there is none; optionally with an explicit '+' sign. */
export function formatVoltage(value: number | null | undefined, unit: string | null | undefined, options: { signed?: boolean } = {}): string {
  if (value === null || value === undefined) return '–';
  const digits = isPerUnit(unit) ? 3 : 1;
  const text = value.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return options.signed && value > 0 ? `+${text}` : text;
}
