/**
 * Lazy loading of the across-scenarios data. The server answers an index of the scenarios at once
 * and the reduced values of each scenario on request; this module puts the parts back together.
 */
import type { AcrossBus, AcrossBusCell, AcrossCell, AcrossData, AcrossLine, AcrossScenario } from './acrossScenarios.ts';

export interface AcrossIndex {
  scenarios: AcrossScenario[];
  period: [number, number] | null;
  has_lodf: boolean;
}

export interface CellsPayload {
  scenario_id: string;
  period_hours: number;
  voltage_unit: string | null;
  lines: { id: string; name: string; class_name: string | null; type: string; ref_full: number | null; cell: AcrossCell }[];
  buses: {
    id: string; name: string; class_name: string | null; type: string;
    unit: string | null; limits: [number | null, number | null] | null; cell: AcrossBusCell;
  }[];
}

export const DEFAULT_LIMITS = [100, 110, 120];

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
        line = { id: item.id, name: item.name, class_name: item.class_name, type: item.type, base: null, cells: {} };
        lines.set(item.id, line);
      }
      if (item.ref_full !== null && (line.base === null || item.ref_full > line.base)) line.base = item.ref_full;
      line.cells[scenario.id] = item.cell;
    }
    for (const item of part.buses) {
      let bus = buses.get(item.id);
      if (!bus) {
        bus = { id: item.id, name: item.name, class_name: item.class_name, type: item.type, unit: item.unit, limits: item.limits, cells: {} };
        buses.set(item.id, bus);
      }
      if (bus.limits === null) bus.limits = item.limits;
      bus.cells[scenario.id] = item.cell;
    }
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'en');
  return {
    scenarios,
    lines: [...lines.values()].sort(byName),
    buses: [...buses.values()].sort(byName),
    has_lodf: scenarios.some((scenario) => scenario.has_lodf),
    period_hours: periodHours,
    period: index.period,
    limits,
  };
}
