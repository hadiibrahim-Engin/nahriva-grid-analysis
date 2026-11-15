import { useEffect, useState } from 'react';
import api from '../api/client';
import SearchableDropdown from './SearchableDropdown';
import { analysisParams, useAnalysis } from '../hooks/useAnalysis';
import { useGridFilter } from '../hooks/useGridFilter';

interface VoltageLevel { kv: number; elements: number }

/** Voltage-level dropdown of the dashboard header (nominal kV of the chosen analysis); empty = all levels. */
export default function VoltageLevelPicker({ refreshKey }: { refreshKey: number }) {
  const { kv, setKv } = useGridFilter();
  const { analysis } = useAnalysis();
  const [levels, setLevels] = useState<VoltageLevel[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.get<VoltageLevel[]>('/voltage-levels', { params: analysisParams(analysis) })
      .then((response) => { if (active) setLevels(Array.isArray(response.data) ? response.data : []); })
      .catch(() => { if (active) setLevels([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refreshKey, analysis]);

  // A remembered level the chosen analysis does not have must not hide everything.
  useEffect(() => {
    if (!loading && kv !== null && !levels.some((l) => l.kv === kv)) setKv(null);
  }, [loading, kv, levels, setKv]);

  return (
    <SearchableDropdown
      label="Voltage level"
      items={levels}
      idOf={(l) => String(l.kv)}
      labelOf={(l) => `${l.kv} kV (${l.elements})`}
      value={kv === null ? null : String(kv)}
      onChange={(value) => setKv(value === null ? null : Number(value))}
      placeholder="- All levels -"
      emptyHint="No nominal voltages stored"
      loading={loading}
      loadingLabel="Loading voltage levels"
      className="min-w-[150px]"
    />
  );
}
