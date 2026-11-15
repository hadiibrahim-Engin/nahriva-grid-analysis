import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { GridFilterContext } from '../hooks/useGridFilter';
import type { GridSelection } from '../util/grids';
import { readParam, writeParam } from '../util/shareLink';

const STORAGE_KEY = 'powerfactoryDashboardGrid';
const KV_KEY = 'powerfactoryDashboardKv';

const readStored = (): GridSelection => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? null : (JSON.parse(raw) as string);
  } catch {
    return null;
  }
};

const readKv = (): number | null => {
  try {
    const raw = localStorage.getItem(KV_KEY);
    return raw === null ? null : Number(raw);
  } catch {
    return null;
  }
};

/** Holds the chosen grid and voltage level for the whole dashboard; remembered per browser so a reload keeps them. */
export default function GridFilterProvider({ children }: { children: ReactNode }) {
  // A shared link (?grid=…&kv=…) takes precedence over what this browser remembers.
  const [grid, setGridState] = useState<GridSelection>(() => readParam('grid') ?? readStored());
  const [kv, setKvState] = useState<number | null>(() => {
    const shared = readParam('kv');
    return shared !== null && Number.isFinite(Number(shared)) ? Number(shared) : readKv();
  });
  const setKv = useCallback((value: number | null) => {
    setKvState(value);
    writeParam('kv', value);
    try {
      if (value === null) localStorage.removeItem(KV_KEY);
      else localStorage.setItem(KV_KEY, String(value));
    } catch { /* storage unavailable: keep it for this visit */ }
  }, []);
  const setGrid = useCallback((value: GridSelection) => {
    setGridState(value);
    writeParam('grid', value);
    try {
      if (value === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch { /* storage unavailable: keep it for this visit */ }
  }, []);
  const value = useMemo(() => ({ grid, setGrid, kv, setKv }), [grid, setGrid, kv, setKv]);
  return <GridFilterContext.Provider value={value}>{children}</GridFilterContext.Provider>;
}
