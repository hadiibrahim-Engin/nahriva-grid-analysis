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

/** The data with only the branches and busbars of one grid; unchanged for "all grids". */
export function restrictToGrid(data: AcrossData, grid: GridSelection): AcrossData {
  if (grid === null) return data;
  return {
    ...data,
    lines: data.lines.filter((line) => inGrid(line, grid)),
    buses: data.buses?.filter((bus) => inGrid(bus, grid)),
  };
}
