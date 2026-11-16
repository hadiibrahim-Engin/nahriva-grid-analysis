import { useEffect, useMemo, useRef, useState } from 'react';
import { analysisParams, useAnalysis } from './useAnalysis';
import api from '../api/client';
import { cellsQuery, committedPrefix, mergeCells, scenarioGroups, type AcrossIndex, type CellsPayload } from '../util/acrossLoad';
import type { AcrossData } from '../util/acrossScenarios';
import { restrictToGrid, type GridSelection } from '../util/grids';
import { useGridFilter } from './useGridFilter';

/** How many groups of scenarios are asked for at the same time. Small on purpose: the database may be large. */
const CONCURRENCY = 2;
// Saved scenarios never change, so their reduced values are shared by every user of this hook (the
// summary and any number of added charts) and fetched at most once per page visit. Switching the
// database reloads the page, which empties this cache.
const cells = new Map<string, Promise<CellsPayload>>();
/** One request for the scenarios of a group that are not cached yet; a promise per scenario either way. */
const fetchCells = (ids: readonly string[]): Promise<CellsPayload>[] => {
  const missing = ids.filter((id) => !cells.has(id));
  if (missing.length > 0) {
    // ids=a&ids=b, the list form the server reads (axios would write ids[]=a), with the limits in force.
    const query = cellsQuery(missing);
    const answer = api.get<{ cells: Record<string, CellsPayload | null> }>(`/across-scenarios/cells?${query}`)
      .then((response) => response.data.cells);
    for (const id of missing) {
      const pending = answer.then((all) => {
        const part = all[id];
        if (!part) throw new Error(`Scenario ${id} could not be loaded.`);
        return part;
      });
      pending.catch(() => cells.delete(id)); // a failed scenario may be tried again later
      cells.set(id, pending);
    }
  }
  return ids.map((id) => cells.get(id)!);
};

// When one user of the hook sees a new scenario in the index, the OTHERS look again (not itself).
let knownIds = '';
const listeners = new Map<object, () => void>();
const announce = (ids: string, self: object) => {
  if (ids === knownIds) return;
  knownIds = ids;
  listeners.forEach((listener, owner) => { if (owner !== self) listener(); });
};

/** Groups arriving close together (two are asked for at once) are shown in one step: each step merges and evaluates
 *  everything. Short: a group arrives in one piece. */
const BATCH_MS = 40;

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
export function useAcrossData(refreshKey: number, filter?: { grid?: GridSelection; kv?: number | null }): AcrossLoad {
  const { analysis } = useAnalysis();
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
        const { data: idx } = await api.get<AcrossIndex>('/across-scenarios/index', { params: analysisParams(analysis) });
        if (!active) return;
        setIndex(idx);
        setError('');
        const ids = idx.scenarios.map((scenario) => scenario.id);
        announce(ids.join(','), self.current);
        const groups = scenarioGroups(ids);
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
            const g = next++;
            if (g >= groups.length) return;
            const group = groups[g];
            const results = await Promise.allSettled(fetchCells(group));
            if (!active) return;
            results.forEach((result, k) => arrived(group[k], result.status === 'fulfilled' ? result.value : null));
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, groups.length) }, worker));
        if (timer !== undefined) clearTimeout(timer);
        flush();
      } catch {
        if (active) setError('The evaluation across all scenarios could not be loaded.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [refreshKey, peerTick, analysis]);

  const header = useGridFilter();
  const grid = filter?.grid === undefined ? header.grid : filter.grid;
  const kv = filter?.kv === undefined ? header.kv : filter.kv;
  const merged = useMemo(() => (index ? mergeCells(index, committedPrefix(index, parts)) : null), [index, parts]);
  const data = useMemo(() => (merged ? restrictToGrid(merged, grid, kv) : null), [merged, grid, kv]);
  const total = index?.scenarios.length ?? 0;
  const failed = index ? index.scenarios.filter((scenario) => parts[scenario.id] === null).length : 0;
  return { data, total, shown: data?.scenarios.length ?? 0, failed, loading, error };
}
