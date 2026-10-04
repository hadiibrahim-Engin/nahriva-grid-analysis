import { useEffect, useState } from 'react';
import api from '../api/client';
import SearchableDropdown from './SearchableDropdown';
import { useGridFilter } from '../hooks/useGridFilter';
import { gridLabel, type GridInfo } from '../util/grids';

/** Grid dropdown of the dashboard header; empty selection = all grids. */
export default function GridPicker({ refreshKey }: { refreshKey: number }) {
  const { grid, setGrid } = useGridFilter();
  const [grids, setGrids] = useState<GridInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.get<GridInfo[]>('/grids')
      .then((response) => { if (active) setGrids(Array.isArray(response.data) ? response.data : []); })
      .catch(() => { if (active) setGrids([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refreshKey]);

  // A remembered grid that the current database does not contain must not hide everything.
  useEffect(() => {
    if (!loading && grid !== null && !grids.some((g) => g.name === grid)) setGrid(null);
  }, [loading, grid, grids, setGrid]);

  return (
    <SearchableDropdown
      label="Grid"
      items={grids}
      idOf={(g) => g.name}
      labelOf={(g) => `${gridLabel(g.name)} (${g.elements})`}
      value={grid}
      onChange={setGrid}
      placeholder="- All grids -"
      emptyHint="No grids in this database"
      loading={loading}
      loadingLabel="Loading grids"
      className="min-w-[180px]"
    />
  );
}
