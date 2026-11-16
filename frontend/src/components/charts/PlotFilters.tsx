import { useEffect, useMemo, useState } from 'react';
import api from '../../api/client';
import { analysisParams, useAnalysis } from '../../hooks/useAnalysis';
import { useGridFilter } from '../../hooks/useGridFilter';
import { isVoltageKind } from '../../util/acrossSelection';
import type { DashboardSeries, DynamicChartConfig } from '../../util/dynamicCharts';
import { gridLabel, type GridInfo } from '../../util/grids';
import type { ChartTemplate } from './chartTemplates';

interface VoltageLevel { kv: number; elements: number }

let gridCache: GridInfo[] | null = null;
let gridRequest: Promise<GridInfo[]> | null = null;
const voltageCache = new Map<string, VoltageLevel[]>();
const voltageRequests = new Map<string, Promise<VoltageLevel[]>>();

function grids(): Promise<GridInfo[]> {
  if (gridCache) return Promise.resolve(gridCache);
  gridRequest ??= api.get<GridInfo[]>('/grids')
    .then((response) => Array.isArray(response.data) ? response.data : [])
    .catch(() => [])
    .then((items) => { gridCache = items; return items; });
  return gridRequest;
}

function voltages(analysis: string | null): Promise<VoltageLevel[]> {
  const key = analysis ?? '';
  const cached = voltageCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = voltageRequests.get(key) ?? api.get<VoltageLevel[]>('/voltage-levels', { params: analysisParams(analysis) })
    .then((response) => Array.isArray(response.data) ? response.data : [])
    .catch(() => [])
    .then((items) => { voltageCache.set(key, items); return items; });
  voltageRequests.set(key, pending);
  return pending;
}

/** Compact, persisted scope controls shared by every user-added plot. */
export default function PlotFilters({ template, config, availableSeries, onChange }: {
  template: ChartTemplate;
  config: DynamicChartConfig;
  availableSeries: DashboardSeries[];
  onChange: (config: DynamicChartConfig) => void;
}) {
  const { analysis } = useAnalysis();
  const header = useGridFilter();
  const [gridOptions, setGridOptions] = useState<GridInfo[]>([]);
  const [voltageOptions, setVoltageOptions] = useState<VoltageLevel[]>([]);
  const grid = config.grid === undefined ? header.grid : config.grid;
  const kv = config.kv === undefined ? header.kv : config.kv;

  useEffect(() => {
    let active = true;
    void grids().then((items) => { if (active) setGridOptions(items); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void voltages(analysis).then((items) => { if (active) setVoltageOptions(items); });
    return () => { active = false; };
  }, [analysis]);

  const equipmentOptions = useMemo(() => {
    const seen = new Map<string, DashboardSeries>();
    const configured = new Set(config.sourceKeys);
    for (const series of availableSeries) {
      if (configured.has(series.key) && !seen.has(series.componentId)) seen.set(series.componentId, series);
    }
    return [...seen.values()].sort((a, b) => a.componentName.localeCompare(b.componentName, 'en'));
  }, [availableSeries, config.sourceKeys]);

  const patch = (next: Partial<DynamicChartConfig>) => onChange({ ...config, ...next });
  const selectClass = 'grid-form-input grid-form-input--compact h-7 min-w-32';

  return (
    <fieldset className="plot-filter-bar">
      <legend className="plot-filter-bar__legend">Plot filters</legend>
      <label className="plot-filter-bar__field">
        <span>Grid</span>
        <select
          className={selectClass}
          value={grid ?? ''}
          onChange={(event) => patch({ grid: event.target.value || null, componentId: null, elementMode: 'auto', elementIds: [] })}
        >
          <option value="">All grids</option>
          {gridOptions.map((item) => <option key={item.name} value={item.name}>{gridLabel(item.name)}</option>)}
        </select>
      </label>
      <label className="plot-filter-bar__field">
        <span>Voltage</span>
        <select
          className={selectClass}
          value={kv ?? ''}
          onChange={(event) => patch({ kv: event.target.value ? Number(event.target.value) : null, componentId: null, elementMode: 'auto', elementIds: [] })}
        >
          <option value="">All levels</option>
          {voltageOptions.map((item) => <option key={item.kv} value={item.kv}>{item.kv} kV</option>)}
        </select>
      </label>
      {template.scenarioLevel ? (
        <label className="plot-filter-bar__field">
          <span>Equipment</span>
          {isVoltageKind(template.kind) ? (
            <select className={selectClass} value="busbar" disabled><option value="busbar">Busbars</option></select>
          ) : (
            <select
              className={selectClass}
              value={config.equipment ?? 'all'}
              onChange={(event) => patch({ equipment: event.target.value as NonNullable<DynamicChartConfig['equipment']>, elementMode: 'auto', elementIds: [] })}
            >
              <option value="all">All equipment</option>
              <option value="line">Lines</option>
              <option value="transformer">Transformers</option>
            </select>
          )}
        </label>
      ) : (
        <label className="plot-filter-bar__field">
          <span>Equipment</span>
          <select
            className={selectClass}
            value={config.componentId ?? ''}
            onChange={(event) => patch({ componentId: event.target.value || null })}
          >
            <option value="">All configured</option>
            {equipmentOptions.map((series) => (
              <option key={series.componentId} value={series.componentId}>
                {series.componentName}{series.nominalKv ? ` · ${series.nominalKv} kV` : ''}
              </option>
            ))}
          </select>
        </label>
      )}
    </fieldset>
  );
}
