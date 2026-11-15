/**
 * Grid filter: restricts equipment and busbars to one PowerFactory grid (ElmNet), e.g. "D7 Grid".
 * The server derives the grid from each element's stored PowerFactory path; '' means "no grid".
 * Pure functions on the across-scenarios payload; the scenarios themselves are never filtered.
 */
import type { AcrossData } from './acrossScenarios.ts';

export interface GridInfo {
  /** Grid name, '' for elements outside any grid. */
  name: string;
  /** Number of distinct elements stored for this grid. */
  elements: number;
}

/** null = all grids. */
export type GridSelection = string | null;

export const NO_GRID_LABEL = '(no grid)';

export const gridLabel = (name: string): string => name || NO_GRID_LABEL;

export function inGrid(item: { grid?: string | null }, grid: GridSelection): boolean {
  return grid === null || (item.grid ?? '') === grid;
}

export function atVoltage(item: { nominal_kv?: number | null }, kv: number | null): boolean {
  return kv === null || item.nominal_kv === kv;
}

/** The data with only the branches and busbars of one grid and voltage level; unchanged for "all". */
export function restrictToGrid(data: AcrossData, grid: GridSelection, kv: number | null = null): AcrossData {
  if (grid === null && kv === null) return data;
  const keep = (item: { grid?: string | null; nominal_kv?: number | null }) => inGrid(item, grid) && atVoltage(item, kv);
  return {
    ...data,
    lines: data.lines.filter(keep),
    buses: data.buses?.filter(keep),
  };
}
