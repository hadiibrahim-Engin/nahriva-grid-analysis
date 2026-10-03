/**
 * Outage (Freischaltung) assessment: which violations the outage causes, and a
 * verdict per scenario. Pure functions on the read-only across-scenarios payload.
 */
import { LOADING_LIMITS } from '../config/loadingBands.ts';
import { ASSESSMENT, type Verdict } from '../config/assessment.ts';
import type { AcrossBus, AcrossBusCell, AcrossCell, AcrossLine, AcrossScenario } from './acrossScenarios.ts';

// -- Equipment kinds -----------------------------------------------------------

export type EquipmentKind = 'line' | 'transformer' | 'other';

export const equipmentKind = (type: string): EquipmentKind =>
  type === 'line' ? 'line' : type === 'transformer' ? 'transformer' : 'other';

export const EQUIPMENT_LABEL: Record<EquipmentKind, string> = {
  line: 'Leitung',
  transformer: 'Transformator',
  other: 'Betriebsmittel',
};
export const EQUIPMENT_PLURAL: Record<EquipmentKind, string> = {
  line: 'Leitungen',
  transformer: 'Transformatoren',
  other: 'Sonstige',
};
/** One-letter marker next to a name; lines (the common case) get none. */
export const EQUIPMENT_MARK: Record<EquipmentKind, string> = { line: '', transformer: 'T', other: '·' };

// -- Cause of a violation --------------------------------------------------------

export type Cause = 'caused' | 'aggravated' | 'preexisting';

export const CAUSE_LABEL: Record<Cause, string> = {
  caused: 'durch Freischaltung verursacht',
  aggravated: 'durch Freischaltung verschärft',
  preexisting: 'Vorbelastung, unverändert',
};

/** Overload (> 100 %) of a branch: new because of the outage, worse because of it, or already there in REF. */
export function causeOf(cell: AcrossCell | undefined): Cause | null {
  if (!cell || cell.outaged || cell.value === null || cell.value <= LOADING_LIMITS.overload) return null;
  const base = cell.window_base;
  if (base === null || base <= LOADING_LIMITS.overload) return 'caused';
  return (cell.delta ?? 0) >= ASSESSMENT.aggravationPp ? 'aggravated' : 'preexisting';
}

// -- Voltage ---------------------------------------------------------------------

export type VoltageState = 'ok' | 'near' | 'violated' | 'unknown';

export interface VoltageResult {
  state: VoltageState;
  cause: Cause | null;
  /** Smallest distance to a limit in p.u.; negative when the band is left. */
  margin: number | null;
}

const isPerUnit = (unit: string | null | undefined): boolean => /^p\.?u\.?$/i.test((unit ?? '').trim());

/** Band a busbar is judged against: the configured p.u. band, or the limits stored with kV results. */
export function busBand(bus: AcrossBus): [number | null, number | null] | null {
  if (isPerUnit(bus.unit)) return [ASSESSMENT.voltageBandPu.lower, ASSESSMENT.voltageBandPu.upper];
  return bus.limits;
}

const marginOf = (range: [number, number], limits: [number | null, number | null]): number | null => {
  const [lower, upper] = limits;
  const distances: number[] = [];
  if (lower !== null) distances.push(range[0] - lower);
  if (upper !== null) distances.push(upper - range[1]);
  return distances.length > 0 ? Math.min(...distances) : null;
};

export function voltageResult(bus: AcrossBus, cell: AcrossBusCell | undefined): VoltageResult {
  const band = busBand(bus);
  if (!cell || cell.outaged || !cell.out || !band) return { state: 'unknown', cause: null, margin: null };
  const margin = marginOf(cell.out, band);
  if (margin === null) return { state: 'unknown', cause: null, margin: null };
  if (margin >= 0) return { state: margin < ASSESSMENT.voltageMarginPu ? 'near' : 'ok', cause: null, margin };
  const refMargin = cell.ref ? marginOf(cell.ref, band) : null;
  let cause: Cause = 'caused';
  if (refMargin !== null && refMargin < 0) {
    cause = margin < refMargin - ASSESSMENT.voltageAggravationPu ? 'aggravated' : 'preexisting';
  }
  return { state: 'violated', cause, margin };
}

// -- Verdict ---------------------------------------------------------------------

export interface Assessment {
  verdict: Verdict;
  /** Short statements that justify the verdict, most important first. */
  reasons: string[];
  caused: number;
  aggravated: number;
  preexisting: number;
  /** In-service branches pushed from below 80 % into the warning range (≤ 100 %). */
  pushedIntoWarning: number;
  /** In-service branches left with less thermal reserve than ASSESSMENT.thermalReservePp because of the outage. */
  lowReserve: number;
  voltageViolations: number;
  voltageNear: number;
  /** Most loaded branch in service and the reserve to 100 % (pp, negative when overloaded). */
  worst: { name: string; value: number; reserve: number } | null;
}

const pct = (v: number) => `${v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
const volt = (v: number, unit: string | null | undefined) =>
  `${v.toLocaleString('de-DE', isPerUnit(unit) ? { minimumFractionDigits: 3, maximumFractionDigits: 3 } : { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function assessScenario(
  scenario: AcrossScenario,
  lines: readonly AcrossLine[],
  buses: readonly AcrossBus[] = [],
): Assessment {
  let caused = 0;
  let aggravated = 0;
  let preexisting = 0;
  let pushed = 0;
  let lowReserve = 0;
  let lowReserveWorst: { name: string; value: number } | null = null;
  let evaluated = 0;
  let worst: Assessment['worst'] = null;
  let worstCaused: { name: string; value: number } | null = null;
  for (const line of lines) {
    const cell = line.cells[scenario.id];
    if (!cell || cell.outaged || cell.value === null) continue;
    evaluated += 1;
    if (worst === null || cell.value > worst.value) {
      worst = { name: line.name, value: cell.value, reserve: LOADING_LIMITS.overload - cell.value };
    }
    const cause = causeOf(cell);
    if (cause === 'caused') caused += 1;
    else if (cause === 'aggravated') aggravated += 1;
    else if (cause === 'preexisting') preexisting += 1;
    else {
      const limit = LOADING_LIMITS.overload - ASSESSMENT.thermalReservePp;
      if (cell.value >= limit && (cell.window_base === null || cell.window_base < limit)) {
        lowReserve += 1;
        if (lowReserveWorst === null || cell.value > lowReserveWorst.value) lowReserveWorst = { name: line.name, value: cell.value };
      } else if (
        cell.value >= LOADING_LIMITS.warning &&
        (cell.window_base === null || cell.window_base < LOADING_LIMITS.warning)
      ) pushed += 1;
    }
    if ((cause === 'caused' || cause === 'aggravated') && (worstCaused === null || cell.value > worstCaused.value)) {
      worstCaused = { name: line.name, value: cell.value };
    }
  }
  let voltageCaused = 0;
  let voltagePre = 0;
  let voltageNear = 0;
  let voltageEvaluated = 0;
  let voltageWorst: { name: string; range: [number, number]; unit: string } | null = null;
  for (const bus of buses) {
    const cell = bus.cells[scenario.id];
    const result = voltageResult(bus, cell);
    if (result.state === 'unknown') continue;
    voltageEvaluated += 1;
    if (result.state === 'near') voltageNear += 1;
    if (result.state === 'violated') {
      if (result.cause === 'preexisting') voltagePre += 1;
      else {
        voltageCaused += 1;
        if (voltageWorst === null && cell?.out) voltageWorst = { name: bus.name, range: cell.out, unit: bus.unit ?? 'p.u.' };
      }
    }
  }

  if (evaluated === 0 && voltageEvaluated === 0) {
    return { verdict: 'unknown', reasons: [], caused, aggravated, preexisting, pushedIntoWarning: pushed, lowReserve, voltageViolations: 0, voltageNear: 0, worst };
  }

  const reasons: string[] = [];
  if (caused > 0) reasons.push(`${plural(caused, 'Betriebsmittel', 'Betriebsmittel')} durch Freischaltung über 100 %${worstCaused ? ` (max. ${worstCaused.name} ${pct(worstCaused.value)})` : ''}`);
  if (aggravated > 0) reasons.push(`${plural(aggravated, 'bestehende Überlastung', 'bestehende Überlastungen')} verschärft`);
  if (voltageCaused > 0) reasons.push(`Spannungsband verlassen: ${plural(voltageCaused, 'Sammelschiene', 'Sammelschienen')}${voltageWorst ? ` (${voltageWorst.name} ${volt(voltageWorst.range[0], voltageWorst.unit)}–${volt(voltageWorst.range[1], voltageWorst.unit)} ${voltageWorst.unit})` : ''}`);
  if (preexisting > 0) reasons.push(`Vorbelastung über 100 % unverändert: ${preexisting}`);
  if (voltagePre > 0) reasons.push(`Spannungsverletzung bereits in REF: ${voltagePre}`);
  if (lowReserve > 0) reasons.push(`${plural(lowReserve, 'Betriebsmittel', 'Betriebsmittel')} mit Reserve < ${ASSESSMENT.thermalReservePp} pp${lowReserveWorst ? ` (max. ${lowReserveWorst.name} ${pct(lowReserveWorst.value)})` : ''}`);
  if (pushed > 0) reasons.push(`${plural(pushed, 'Betriebsmittel', 'Betriebsmittel')} in den Warnbereich (≥ 80 %) gebracht`);
  if (voltageNear > 0) reasons.push(`Spannung nahe der Grenze: ${plural(voltageNear, 'Sammelschiene', 'Sammelschienen')}`);

  let verdict: Verdict;
  if (caused + aggravated + voltageCaused > 0) verdict = 'not-permissible';
  else if (preexisting + pushed + lowReserve + voltagePre + voltageNear > 0) verdict = 'conditional';
  else verdict = 'permissible';
  if (verdict === 'permissible' && worst) {
    reasons.push(`Höchste Auslastung ${pct(worst.value)} (${worst.name}), Reserve ${worst.reserve.toLocaleString('de-DE', { maximumFractionDigits: 1 })} pp`);
  }
  return {
    verdict, reasons, caused, aggravated, preexisting, pushedIntoWarning: pushed, lowReserve,
    voltageViolations: voltageCaused + voltagePre, voltageNear, worst,
  };
}

const VERDICT_RANK: Record<Verdict, number> = { 'not-permissible': 0, conditional: 1, permissible: 2, unknown: 3 };
export const compareVerdict = (a: Assessment, b: Assessment): number => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict];

export function verdictCounts(assessments: Iterable<Assessment>): Record<Verdict, number> {
  const counts: Record<Verdict, number> = { permissible: 0, conditional: 0, 'not-permissible': 0, unknown: 0 };
  for (const a of assessments) counts[a.verdict] += 1;
  return counts;
}
