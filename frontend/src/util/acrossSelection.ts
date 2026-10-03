/**
 * Which equipment and scenarios a scenario evaluation chart shows: either the chosen ones exactly, or
 * the automatic top N. Also the voltage value per busbar and scenario that the voltage charts plot.
 * Pure functions on the across-scenarios payload.
 */
import { busBand } from './outageAssessment.ts';
import type { AcrossBus, AcrossBusCell, AcrossData, AcrossLine, AcrossScenario } from './acrossScenarios.ts';

export interface SelectionConfig {
  elementMode?: 'auto' | 'selected';
  elementIds?: string[];
  scenarioIds?: string[];
  topN?: number;
}

/** Voltage charts work on busbars, all others on lines and transformers. */
export const isVoltageKind = (kind: string): boolean => kind === 'acrossVoltage' || kind === 'acrossVoltageDelta';

export const isSelecting = (config: SelectionConfig): boolean => config.elementMode === 'selected';

/** Chosen scenarios in their fixed order; no choice means all of them. */
export function pickScenarios<T extends { id: string }>(scenarios: readonly T[], ids?: readonly string[]): T[] {
  if (!ids || ids.length === 0) return [...scenarios];
  const wanted = new Set(ids);
  return scenarios.filter((scenario) => wanted.has(scenario.id));
}

/** The data restricted to the chosen scenarios (cells of other scenarios simply stay unused). */
export function restrictScenarios(data: AcrossData, ids?: readonly string[]): AcrossData {
  return { ...data, scenarios: pickScenarios<AcrossScenario>(data.scenarios, ids) };
}

/** Exactly the chosen items, in name order; items that no longer exist are ignored. */
export function pickChosen<T extends { id: string; name: string }>(items: readonly T[], ids: readonly string[] = []): T[] {
  const wanted = new Set(ids);
  return items.filter((item) => wanted.has(item.id)).sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export interface BusValue {
  /** The voltage extreme of the window that lies closer to a limit. */
  value: number;
  side: 'low' | 'high';
  /** The same side's extreme of the reference run in the same window. */
  ref: number | null;
  /** value minus ref, in the unit of the results. */
  delta: number | null;
  /** Distance to the nearest limit; negative when the band is left. */
  margin: number | null;
}

export function busValue(bus: AcrossBus, cell: AcrossBusCell | undefined): BusValue | null {
  if (!cell || cell.outaged || !cell.out) return null;
  const band = busBand(bus);
  const [low, high] = cell.out;
  const lowMargin = band && band[0] !== null ? low - band[0] : null;
  const highMargin = band && band[1] !== null ? band[1] - high : null;
  let side: 'low' | 'high';
  if (lowMargin !== null && highMargin !== null) side = lowMargin <= highMargin ? 'low' : 'high';
  else if (lowMargin !== null) side = 'low';
  else if (highMargin !== null) side = 'high';
  else if (cell.ref) side = Math.abs(low - cell.ref[0]) >= Math.abs(high - cell.ref[1]) ? 'low' : 'high'; // no band: the side that moved more
  else side = 'low';
  const value = side === 'low' ? low : high;
  const ref = cell.ref ? (side === 'low' ? cell.ref[0] : cell.ref[1]) : null;
  return {
    value,
    side,
    ref,
    delta: ref === null ? null : value - ref,
    margin: side === 'low' ? lowMargin : highMargin,
  };
}

/** The tightest margin of a busbar over the given scenarios (smaller = closer to or beyond a limit). */
export function tightestMargin(bus: AcrossBus, scenarios: readonly AcrossScenario[]): number {
  let tightest = Infinity;
  for (const scenario of scenarios) {
    const margin = busValue(bus, bus.cells[scenario.id])?.margin;
    if (margin !== null && margin !== undefined && margin < tightest) tightest = margin;
  }
  return tightest;
}

/** Busbars to show: the chosen ones, or the N with the tightest voltage margin. */
export function pickBuses(
  buses: readonly AcrossBus[],
  scenarios: readonly AcrossScenario[],
  config: SelectionConfig,
): AcrossBus[] {
  if (isSelecting(config)) return pickChosen(buses, config.elementIds);
  return [...buses]
    .sort((a, b) => tightestMargin(a, scenarios) - tightestMargin(b, scenarios) || a.name.localeCompare(b.name, 'en'))
    .slice(0, config.topN && config.topN > 0 ? config.topN : 12);
}

/** Branches to show when the user chose them; null means "automatic": the caller applies its top N. */
export function chosenLines(lines: readonly AcrossLine[], config: SelectionConfig): AcrossLine[] | null {
  return isSelecting(config) ? pickChosen(lines, config.elementIds) : null;
}
