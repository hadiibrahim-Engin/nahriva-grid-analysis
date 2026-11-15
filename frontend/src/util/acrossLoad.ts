/**
 * Lazy loading of the across-scenarios data. The server answers an index of the scenarios at once
 * and the reduced values of each scenario on request; this module puts the parts back together.
 */
import type { AcrossBus, AcrossBusCell, AcrossCell, AcrossData, AcrossLine, AcrossScenario } from './acrossScenarios.ts';
import { ASSESSMENT } from '../config/assessment.ts';
import { LOADING_LIMITS } from '../config/loadingBands.ts';

export interface AcrossIndex {
  scenarios: AcrossScenario[];
  period: [number, number] | null;
  has_lodf: boolean;
}

export interface CellsPayload {
  scenario_id: string;
  period_hours: number;
  voltage_unit: string | null;
  lines: { id: string; name: string; class_name: string | null; type: string; grid?: string | null; nominal_kv?: number | null; ref_full: number | null; cell: AcrossCell }[];
  buses: {
    id: string; name: string; class_name: string | null; type: string; grid?: string | null; nominal_kv?: number | null;
    unit: string | null; limits: [number | null, number | null] | null; cell: AcrossBusCell;
  }[];
  /** Only for a large scenario: how many elements it has and how many were listed (see cellsQuery). */
  listing?: Listing;
}

export interface Listing {
  lines: number;
  buses: number;
  listed_lines: number;
  listed_buses: number;
  warning: number;
  band: [number, number];
  margin: number;
  top: number;
}

/** Loading limits (%) the server counts hours above: the overload, clear and severe limits in force. */
export const DEFAULT_LIMITS = [LOADING_LIMITS.overload, LOADING_LIMITS.clear, LOADING_LIMITS.severe];

/**
 * Query of a cells request: the hour limits and the thresholds that decide what a large scenario lists (the server
 * sends every element of a scenario with at most 5,000, otherwise the ones these thresholds make relevant).
 */
export function cellsQuery(ids: readonly string[]): URLSearchParams {
  const query = new URLSearchParams(ids.map((id) => ['ids', id]));
  for (const limit of DEFAULT_LIMITS) query.append('over', String(limit));
  query.set('warning', String(LOADING_LIMITS.warning));
  query.set('band_lower', String(ASSESSMENT.voltageBandPu.lower));
  query.set('band_upper', String(ASSESSMENT.voltageBandPu.upper));
  query.set('margin', String(ASSESSMENT.voltageMarginPu));
  return query;
}

/** Group sizes for loading: a small first group shows the first verdicts at once, then few large answers follow (the
 *  last size repeats). Every group arrives in one piece and the summary is evaluated once per group, not per scenario. */
const GROUP_SIZES = [3, 6, 12, 24];

/** The scenario ids in index order, cut into groups of GROUP_SIZES. */
export function scenarioGroups(ids: readonly string[]): string[][] {
  const groups: string[][] = [];
  for (let i = 0, g = 0; i < ids.length; g += 1) {
    const size = GROUP_SIZES[Math.min(g, GROUP_SIZES.length - 1)];
    groups.push(ids.slice(i, i + size));
    i += size;
  }
  return groups;
}

/**
 * The scenarios whose values are present, as a prefix of the index order. Showing a prefix keeps the
 * scenario codes (S01, S02 …) stable while later scenarios are still loading. A failed scenario
 * (null) is skipped but does not block the ones after it.
 */
export function committedPrefix(
  index: AcrossIndex,
  received: Record<string, CellsPayload | null | undefined>,
): Record<string, CellsPayload> {
  const committed: Record<string, CellsPayload> = {};
  for (const scenario of index.scenarios) {
    const part = received[scenario.id];
    if (part === undefined) break;
    if (part !== null) committed[scenario.id] = part;
  }
  return committed;
}

export function mergeCells(index: AcrossIndex, parts: Record<string, CellsPayload>, limits = DEFAULT_LIMITS): AcrossData {
  const scenarios = index.scenarios.filter((scenario) => parts[scenario.id]);
  const lines = new Map<string, AcrossLine>();
  const buses = new Map<string, AcrossBus>();
  let periodHours = 0;
  let voltageUnit: string | null = null;
  for (const scenario of scenarios) {
    const part = parts[scenario.id];
    periodHours = Math.max(periodHours, part.period_hours);
    voltageUnit = voltageUnit ?? part.voltage_unit;
    for (const item of part.lines) {
      let line = lines.get(item.id);
      if (!line) {
        line = { id: item.id, name: item.name, class_name: item.class_name, type: item.type, grid: item.grid, nominal_kv: item.nominal_kv ?? null, base: null, cells: {} };
        lines.set(item.id, line);
      }
      if (item.ref_full !== null && (line.base === null || item.ref_full > line.base)) line.base = item.ref_full;
      line.cells[scenario.id] = item.cell;
    }
    for (const item of part.buses) {
      let bus = buses.get(item.id);
      if (!bus) {
        bus = { id: item.id, name: item.name, class_name: item.class_name, type: item.type, grid: item.grid, nominal_kv: item.nominal_kv ?? null, unit: item.unit, limits: item.limits, cells: {} };
        buses.set(item.id, bus);
      }
      if (bus.limits === null) bus.limits = item.limits;
      bus.cells[scenario.id] = item.cell;
    }
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'en');
  // A large analysis lists the relevant elements of each scenario; together they are the union shown here.
  const cut = scenarios.map((scenario) => parts[scenario.id].listing).find((listing) => listing);
  const listing = cut ? { ...cut, listed_lines: lines.size, listed_buses: buses.size } : null;
  return {
    listing,
    scenarios,
    lines: [...lines.values()].sort(byName),
    buses: [...buses.values()].sort(byName),
    has_lodf: scenarios.some((scenario) => scenario.has_lodf),
    period_hours: periodHours,
    period: index.period,
    limits,
  };
}
