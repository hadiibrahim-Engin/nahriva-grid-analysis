import { createContext, useContext } from 'react';
import type { GridSelection } from '../util/grids';

export interface GridFilter {
  grid: GridSelection;
  setGrid: (grid: GridSelection) => void;
}

/**
 * The grid chosen in the dashboard header (see components/GridFilterProvider). Every part of the
 * dashboard reads it: the equipment dropdown, the summary (key figures, verdicts, tables, plots)
 * and the added scenario charts. Without a provider: all grids.
 */
export const GridFilterContext = createContext<GridFilter>({ grid: null, setGrid: () => {} });

export const useGridFilter = (): GridFilter => useContext(GridFilterContext);
