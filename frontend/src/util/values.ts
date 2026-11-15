/** True for a finite number; false for a point without a value (null) or a non-finite one. */
export function isFiniteValue(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
