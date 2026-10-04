import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../api/client';
import { committedPrefix, mergeCells, type AcrossIndex, type CellsPayload } from '../util/acrossLoad';
import type { AcrossData } from '../util/acrossScenarios';
import { restrictToGrid } from '../util/grids';
import { useGridFilter } from './useGridFilter';

/** How many scenarios the server reduces at the same time. Small on purpose: the database may be large. */
const CONCURRENCY = 3;

// Saved scenarios never change, so their reduced values are shared by every user of this hook (the
// summary and any number of added charts) and fetched at most once per page visit. Switching the
// database reloads the page, which empties this cache.
const cells = new Map<string, Promise<CellsPayload>>();
const fetchCells = (id: string): Promise<CellsPayload> => {
  let pending = cells.get(id);
  if (!pending) {
    pending = api.get<CellsPayload>(`/across-scenarios/${encodeURIComponent(id)}/cells`).then((response) => response.data);
    pending.catch(() => cells.delete(id)); // a failed scenario may be tried again later
    cells.set(id, pending);
  }
  return pending;
};

// When one user of the hook sees a new scenario in the index, the OTHERS look again (not itself).
let knownIds = '';
const listeners = new Map<object, () => void>();
const announce = (ids: string, self: object) => {
  if (ids === knownIds) return;
  knownIds = ids;
  listeners.forEach((listener, owner) => { if (owner !== self) listener(); });
};

/** Scenarios arriving close together are shown in one step: each step merges and evaluates everything. */
const BATCH_MS = 120;

export interface AcrossLoad {
  data: AcrossData | null;
  /** Scenarios in the index, shown so far, and failed. */
  total: number;
  shown: number;
  failed: number;
  loading: boolean;
  error: string;
}

/**
 * Index first (instant), then the values of each scenario in the background. Scenarios appear in
 * their fixed order as they arrive, so the first verdicts are visible long before the last scenario
 * is reduced. A refresh only fetches scenarios that are not cached yet.
 * The data is restricted to the grid chosen in the dashboard header (all grids when none is chosen).
 */
export function useAcrossData(refreshKey: number): AcrossLoad {
  const [index, setIndex] = useState<AcrossIndex | null>(null);
  const [parts, setParts] = useState<Record<string, CellsPayload | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [peerTick, setPeerTick] = useState(0);
  const self = useRef({});

  useEffect(() => {
    const owner = self.current;
    listeners.set(owner, () => setPeerTick((tick) => tick + 1));
    return () => { listeners.delete(owner); };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    (async () => {
      try {
        const { data: idx } = await api.get<AcrossIndex>('/across-scenarios/index');
        if (!active) return;
        setIndex(idx);
        setError('');
        const ids = idx.scenarios.map((scenario) => scenario.id);
        announce(ids.join(','), self.current);
        let next = 0;
        let buffer: Record<string, CellsPayload | null> = {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        const flush = () => {
          timer = undefined;
          const batch = buffer;
          buffer = {};
          if (active && Object.keys(batch).length > 0) setParts((previous) => ({ ...previous, ...batch }));
        };
        const arrived = (id: string, value: CellsPayload | null) => {
          buffer[id] = value;
          if (timer === undefined) timer = setTimeout(flush, BATCH_MS);
        };
        const worker = async () => {
          while (active) {
            const i = next++;
            if (i >= ids.length) return;
            try {
              const data = await fetchCells(ids[i]);
              if (active) arrived(ids[i], data);
            } catch {
              if (active) arrived(ids[i], null);
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
        if (timer !== undefined) clearTimeout(timer);
        flush();
      } catch {
        if (active) setError('The evaluation across all scenarios could not be loaded.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [refreshKey, peerTick]);

  const { grid } = useGridFilter();
  const merged = useMemo(() => (index ? mergeCells(index, committedPrefix(index, parts)) : null), [index, parts]);
  const data = useMemo(() => (merged ? restrictToGrid(merged, grid) : null), [merged, grid]);
  const total = index?.scenarios.length ?? 0;
  const failed = index ? index.scenarios.filter((scenario) => parts[scenario.id] === null).length : 0;
  return { data, total, shown: data?.scenarios.length ?? 0, failed, loading, error };
}
