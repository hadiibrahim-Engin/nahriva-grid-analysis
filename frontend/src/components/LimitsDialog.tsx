import { useRef, useState } from 'react';
import { ASSESSMENT, DEFAULT_ASSESSMENT } from '../config/assessment';
import { DEFAULT_LOADING_LIMITS, LOADING_LIMITS } from '../config/loadingBands';
import { clearOverrides, saveOverrides, type LimitOverrides } from '../config/overrides';

type Field = keyof LimitOverrides;
const FIELDS: { key: Field; label: string; unit: string; step: number; current: number; fallback: number }[] = [
  { key: 'warning', label: 'Warning from', unit: '%', step: 1, current: LOADING_LIMITS.warning, fallback: DEFAULT_LOADING_LIMITS.warning },
  { key: 'overload', label: 'Overload above', unit: '%', step: 1, current: LOADING_LIMITS.overload, fallback: DEFAULT_LOADING_LIMITS.overload },
  { key: 'clear', label: 'Clear overload above', unit: '%', step: 1, current: LOADING_LIMITS.clear, fallback: DEFAULT_LOADING_LIMITS.clear },
  { key: 'severe', label: 'Strong overload above', unit: '%', step: 1, current: LOADING_LIMITS.severe, fallback: DEFAULT_LOADING_LIMITS.severe },
  { key: 'voltageLower', label: 'Voltage band, lower', unit: 'p.u.', step: 0.005, current: ASSESSMENT.voltageBandPu.lower, fallback: DEFAULT_ASSESSMENT.voltageBandPu.lower },
  { key: 'voltageUpper', label: 'Voltage band, upper', unit: 'p.u.', step: 0.005, current: ASSESSMENT.voltageBandPu.upper, fallback: DEFAULT_ASSESSMENT.voltageBandPu.upper },
  { key: 'voltageMargin', label: 'Close to the band within', unit: 'p.u.', step: 0.005, current: ASSESSMENT.voltageMarginPu, fallback: DEFAULT_ASSESSMENT.voltageMarginPu },
  { key: 'thermalReservePp', label: 'Small thermal reserve below', unit: 'pp', step: 1, current: ASSESSMENT.thermalReservePp, fallback: DEFAULT_ASSESSMENT.thermalReservePp },
  { key: 'aggravationPp', label: 'Aggravated overload from', unit: 'pp', step: 0.5, current: ASSESSMENT.aggravationPp, fallback: DEFAULT_ASSESSMENT.aggravationPp },
];

/**
 * The thresholds of the dashboard's evaluation, changeable for this browser. Saving reloads the dashboard so every
 * band, legend and verdict uses the new values. The hours above the limit in the n-1 charts and the counts of the time-point view use the limits
 * set for the run in PowerFactory instead; the dialog says so.
 */
export default function LimitsDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [values, setValues] = useState<Record<Field, string>>(
    () => Object.fromEntries(FIELDS.map((f) => [f.key, String(f.current)])) as Record<Field, string>);
  const parsed = Object.fromEntries(FIELDS.map((f) => [f.key, Number(values[f.key])])) as Record<Field, number>;
  const problems = [
    FIELDS.some((f) => !Number.isFinite(parsed[f.key]) || parsed[f.key] < 0) && 'Every value must be a number of at least 0.',
    !(parsed.warning < parsed.overload && parsed.overload < parsed.clear && parsed.clear < parsed.severe) && 'Loading limits must rise from warning to strong overload.',
    !(parsed.voltageLower < parsed.voltageUpper) && 'The lower voltage limit must lie below the upper one.',
  ].filter(Boolean) as string[];
  const changed = FIELDS.some((f) => f.current !== f.fallback);

  const save = () => {
    // Only what differs from the default is stored, so a later change of a default still applies.
    saveOverrides(Object.fromEntries(FIELDS.filter((f) => parsed[f.key] !== f.fallback).map((f) => [f.key, parsed[f.key]])));
    window.location.reload();
  };
  const reset = () => { clearOverrides(); window.location.reload(); };

  return (
    <>
      <button type="button" className="ab-chip" aria-pressed={changed} onClick={() => dialog.current?.showModal()}
        title="Thresholds of the evaluation (this browser)">
        Limits{changed ? ' · changed' : ''}
      </button>
      <dialog ref={dialog} className="ab-dialog" aria-label="Evaluation limits">
        <div className="ab-dialog__head">
          <h3 className="across-card__title">Evaluation limits</h3>
          <button type="button" className="ab-chip" onClick={() => dialog.current?.close()}>Close</button>
        </div>
        <p className="across-card__hint">
          These thresholds decide bands, verdicts and key figures of the summary, in this browser only. The hours above the
          limit in the n-1 charts and the violation counts of the time-point view use the limits set for the run in
          PowerFactory (case manager settings). With limits other than 100/110/120 % the server recalculates each scenario once.
        </p>
        <div className="ab-limits">
          {FIELDS.map((f) => (
            <label key={f.key} className="ab-limits__row">
              <span>{f.label}</span>
              <input type="number" className="ab-control" step={f.step} min={0} value={values[f.key]}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
              <span className="ab-sub">{f.unit} · default {f.fallback}</span>
            </label>
          ))}
        </div>
        {problems.map((p) => <p key={p} role="alert" className="ab-dialog__limits">{p}</p>)}
        <div className="ab-dialog__actions">
          <button type="button" className="ab-chip" onClick={reset} disabled={!changed}>Reset to defaults</button>
          <button type="button" className="ab-chip" onClick={save} disabled={problems.length > 0}>Save and reload</button>
        </div>
      </dialog>
    </>
  );
}
