import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { GridFilterContext } from '../hooks/useGridFilter';
import type { GridSelection } from '../util/grids';

const STORAGE_KEY = 'powerfactoryDashboardGrid';

const readStored = (): GridSelection => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? null : (JSON.parse(raw) as string);
  } catch {
    return null;
  }
};

/** Holds the chosen grid for the whole dashboard; remembered per browser so a reload keeps it. */
export default function GridFilterProvider({ children }: { children: ReactNode }) {
  const [grid, setGridState] = useState<GridSelection>(readStored);
  const setGrid = useCallback((value: GridSelection) => {
    setGridState(value);
    try {
      if (value === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch { /* storage unavailable: keep it for this visit */ }
  }, []);
  const value = useMemo(() => ({ grid, setGrid }), [grid, setGrid]);
  return <GridFilterContext.Provider value={value}>{children}</GridFilterContext.Provider>;
}
