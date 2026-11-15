import { lazy, memo, Suspense, useEffect, useMemo, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { views, utc, type ScenarioTimes, type Snapshot, type ViewMetric } from '../../api/views';
import ReactECharts from '../charts/ReactECharts';
import { useChartTheme } from '../../hooks/useChartTheme';
import { useGridFilter } from '../../hooks/useGridFilter';
import { readAcrossColors, withAlpha } from '../../util/acrossColors';
import { SUMMARY_IDS } from '../../util/acrossScenarios';
import { downloadText, fileSafe, toCsv } from '../../util/csv';
import { SectionCard } from '../across/shared';
import { setTimeRange, useTimeRange } from '../../hooks/useTimeRange';
import { inRange, zoomedRange, type TimeRange } from '../../util/timeRange';
import RestoreDialog from './RestoreDialog';
// The map is optional: its code, its SVG and its values load only while it is shown.
const NetworkMap = lazy(() => import('./NetworkMap'));
const MAP_KEY = 'oa.networkMap.visible';

/** Whether this browser shows the network map (off by default, so the dashboard stays as fast as without it). */
function readMapVisible(): boolean {
  try {
    return window.localStorage.getItem(MAP_KEY) === '1';
  } catch {
    return false;
  }
}

echarts.use([LineChart, BarChart, GridComponent, LegendComponent, TooltipComponent, MarkAreaComponent, DataZoomComponent, CanvasRenderer]);

const PAGE = 50;
const fmt = (metric: ViewMetric, v: number | null | undefined) =>
  v === null || v === undefined ? '–' : metric === 'loading' ? `${v.toFixed(1)} %` : `${v.toFixed(3)} p.u.`;

/**
 * The network of one scenario at one time: over the whole period the worst value and the number of violations per
 * time (scenario against REF), the most critical times, and for one chosen time every element with its REF value,
 * scenario value and change, worst first. Everything follows the grid and voltage level of the header.
 */
export default memo(function TimePointView({ scenarioId, label, refreshKey, onPickAsset }: {
  scenarioId: string; label: string; refreshKey: number;
  /** A click on an element of the network map: show it in the asset view. */
  onPickAsset?: (elementId: string) => void;
}) {
  const theme = useChartTheme();
  const colors = useMemo(() => readAcrossColors(theme.isLight), [theme.isLight]);
  const { grid, kv } = useGridFilter();
  const [metric, setMetric] = useState<ViewMetric>('loading');
  const [times, setTimes] = useState<{ id: string; data: ScenarioTimes } | null>(null);
  const [chosen, setChosen] = useState<{ id: string; t: number } | null>(null);
  const [snapshot, setSnapshot] = useState<{ key: string; data: Snapshot } | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [error, setError] = useState('');
  const [mapVisible, setMapVisible] = useState(readMapVisible);
  const toggleMap = () => setMapVisible((visible) => {
    try {
      window.localStorage.setItem(MAP_KEY, visible ? '0' : '1');
    } catch {
      // Without storage the choice holds for this page only.
    }
    return !visible;
  });
  const range = useTimeRange();
  const courseKey = `${scenarioId}|${range.from}|${range.to}`;
  // The span the course chart is zoomed to, offered as the time range (then loaded at full resolution).
  const [zoom, setZoom] = useState<{ key: string; range: TimeRange } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    views.times(scenarioId, range, controller.signal)
      .then((data) => { setTimes({ id: courseKey, data }); setError(''); })
      .catch(() => { if (!controller.signal.aborted) setError('The time course could not be loaded.'); });
    return () => controller.abort();
  }, [courseKey, scenarioId, range, refreshKey]);

  const data = times?.id === courseKey ? times.data : null;
  const zoomed = zoom?.key === courseKey ? zoom.range : null;
  // The chosen time of this scenario (while inside the time range), else its most critical one.
  const t = chosen?.id === scenarioId && inRange(range, chosen.t) ? chosen.t : data?.critical[0] ?? data?.times[0] ?? null;
  const key = `${scenarioId}|${t}|${metric}|${grid}|${kv}|${limit}`;

  useEffect(() => {
    if (t === null) return;
    const controller = new AbortController();
    views.snapshot(scenarioId, t, metric, { limit, offset: 0 }, { grid, kv }, controller.signal)
      .then((result) => setSnapshot({ key, data: result }))
      .catch(() => { if (!controller.signal.aborted) setError('The network at this time could not be loaded.'); });
    return () => controller.abort();
  }, [key, scenarioId, t, metric, grid, kv, limit]);

  const shown = snapshot?.key === key ? snapshot.data : null;

  const courseOption = useMemo(() => {
    if (!data || data.times.length === 0) return null;
    const stamps = data.times.map((x) => x * 1000);
    const pairs = (values: (number | null)[]) => values.map((v, i) => [stamps[i], v]);
    const line = (name: string, values: (number | null)[], color: string, dashed = false) => ({
      type: 'line' as const, name, showSymbol: false, connectNulls: false, sampling: 'lttb' as const,
      lineStyle: { color, width: dashed ? 1 : 1.6, type: dashed ? 'dashed' as const : 'solid' as const }, itemStyle: { color },
      data: pairs(values),
    });
    const loading = metric === 'loading';
    const series: object[] = loading
      ? [line('Scenario: highest loading', data.outage.loading_max, colors.bands.severe),
         line('REF: highest loading', data.ref.loading_max, theme.mutedText, true)]
      : [line('Scenario: lowest voltage', data.outage.voltage_min, colors.neg),
         line('Scenario: highest voltage', data.outage.voltage_max, colors.pos),
         line('REF: lowest voltage', data.ref.voltage_min, theme.mutedText, true)];
    series.push({
      type: 'bar', name: loading ? 'Branches above their limit' : 'Nodes outside their band', yAxisIndex: 1, barMaxWidth: 4,
      itemStyle: { color: withAlpha(colors.bands.light, 0.55) }, data: pairs(loading ? data.outage.loading_over : data.outage.voltage_outside),
    });
    (series[0] as { markArea?: object }).markArea = {
      silent: true, itemStyle: { color: withAlpha(colors.lodf, theme.isLight ? 0.08 : 0.14) },
      data: data.windows.map(([a, b]) => [{ xAxis: a * 1000 }, { xAxis: b * 1000 }]),
    };
    if (t !== null) {
      (series[0] as { markLine?: object }).markLine = {
        silent: true, symbol: 'none', lineStyle: { color: theme.text, type: 'solid', width: 1 }, label: { show: false },
        data: [{ xAxis: t * 1000 }],
      };
    }
    return {
      backgroundColor: 'transparent', textStyle: { color: theme.mutedText, fontSize: 11 },
      legend: { top: 0, type: 'scroll', textStyle: { color: theme.text, fontSize: 11 } },
      tooltip: { trigger: 'axis', backgroundColor: theme.tooltipBg, borderColor: theme.tooltipBorder, textStyle: { color: theme.text, fontSize: 12 } },
      grid: { left: 8, right: 16, top: 34, bottom: 44, containLabel: true },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 14, bottom: 6 }],
      xAxis: { type: 'time', axisLabel: { color: theme.mutedText, fontSize: 10 }, axisLine: { lineStyle: { color: theme.axis } } },
      yAxis: [
        { type: 'value', scale: true, axisLabel: { color: theme.mutedText, fontSize: 10, formatter: loading ? '{value} %' : '{value}' }, splitLine: { lineStyle: { color: theme.grid } } },
        { type: 'value', minInterval: 1, axisLabel: { color: theme.mutedText, fontSize: 10 }, splitLine: { show: false } },
      ],
      series,
    };
  }, [data, metric, colors, theme, t]);

  const pick = useMemo(() => ({
    datazoom: (params: unknown) => {
      if (!data || data.times.length < 2) return;
      setZoom({ key: courseKey, range: zoomedRange(params, data.times[0], data.times[data.times.length - 1]) ?? { from: null, to: null } });
    },
    click: (params: unknown) => {
      const value = (params as { value?: unknown }).value;
      if (!data || !Array.isArray(value) || typeof value[0] !== 'number') return;
      const target = Math.round(value[0] / 1000);
      const nearest = data.times.reduce((best, x) => (Math.abs(x - target) < Math.abs(best - target) ? x : best), data.times[0]);
      setChosen({ id: scenarioId, t: nearest });
      setLimit(PAGE);
    },
  }), [data, scenarioId, courseKey]);

  const distributionOption = useMemo(() => {
    if (!shown) return null;
    const { edges, outage, ref } = shown.distribution;
    const unit = metric === 'loading' ? ' %' : '';
    const labels = outage.map((_c, i) => (i === 0 ? `< ${edges[0]}${unit}` : i === edges.length ? `≥ ${edges[i - 1]}${unit}` : `${edges[i - 1]}–${edges[i]}${unit}`));
    return {
      backgroundColor: 'transparent', textStyle: { color: theme.mutedText, fontSize: 11 },
      legend: { top: 0, textStyle: { color: theme.text, fontSize: 11 } },
      tooltip: { trigger: 'axis', backgroundColor: theme.tooltipBg, borderColor: theme.tooltipBorder, textStyle: { color: theme.text, fontSize: 12 } },
      grid: { left: 8, right: 8, top: 28, bottom: 8, containLabel: true },
      xAxis: { type: 'category', data: labels, axisLabel: { color: theme.mutedText, fontSize: 10, rotate: 30 } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { color: theme.mutedText, fontSize: 10 }, splitLine: { lineStyle: { color: theme.grid } } },
      series: [
        { type: 'bar', name: 'REF', data: ref, itemStyle: { color: withAlpha(theme.mutedText, 0.6) } },
        { type: 'bar', name: 'Scenario', data: outage, itemStyle: { color: colors.bands.light } },
      ],
    };
  }, [shown, metric, theme, colors]);

  const exportCsv = async () => {
    if (t === null || !shown) return;
    const rows = [];
    for (let offset = 0; offset < shown.total; offset += 1000) {
      rows.push(...(await views.snapshot(scenarioId, t, metric, { limit: 1000, offset }, { grid, kv })).rows);
    }
    downloadText(`network-${fileSafe(label)}-${t}-${metric}.csv`, toCsv(
      ['Element', 'Class', 'Grid', 'Nominal kV', 'REF', 'Scenario', 'Delta', 'Lower limit', 'Upper limit', 'State'],
      rows.map((r) => [r.name, r.class_name, r.grid, r.nominal_kv, r.ref, r.value, r.delta, r.lower, r.upper, r.state])));
  };

  return (
    <SectionCard
      id={SUMMARY_IDS.timepoint}
      title={`Network at a time · ${label}`}
      hint="Top: per time the worst value of the scenario against REF and how many elements violate their limit; the shaded area is the outage window. Click the course or a critical time to choose a time. Below: every element at that time, worst first, with REF, scenario and change. Grid and voltage level of the header apply."
      actions={
        <div className="ab-chips">
          {(['loading', 'voltage'] as const).map((m) => (
            <button key={m} type="button" className="ab-chip" aria-pressed={metric === m} onClick={() => { setMetric(m); setLimit(PAGE); }}>
              {m === 'loading' ? 'Loading' : 'Voltage'}
            </button>
          ))}
          <button type="button" className="ab-chip" aria-pressed={mapVisible} onClick={toggleMap}
            title="Show or hide the network map (hidden: nothing of it is loaded)">
            Network map
          </button>
          <RestoreDialog scenarioId={scenarioId} label={label} t={t} />
        </div>
      }
    >
      {error && <div className="ab-empty" role="alert">{error}</div>}
      {!data && !error && <div className="ab-empty" aria-busy>Loading time course …</div>}
      {data && data.source === 'computed' && <p className="across-card__hint">Aggregated from the stored values (imported before the time summary existed).</p>}
      {data && data.times.length === 0 && <div className="ab-empty">No calculated time in the chosen time range.</div>}
      {data && (data.interval_steps > 1 || (zoomed && zoomed.from !== null)) && (
        <div className="ab-chips">
          {data.interval_steps > 1 && <span className="ab-sub">Reduced: the worst of every {data.interval_steps} times is shown. Zoom in and load the span for every time.</span>}
          {zoomed && zoomed.from !== null && (
            <button type="button" className="ab-chip" onClick={() => setTimeRange(zoomed)}>Use zoomed span as time range</button>
          )}
        </div>
      )}
      {courseOption && <ReactECharts echarts={echarts} option={courseOption} notMerge style={{ height: 260 }} onEvents={pick} exportName={`course-${fileSafe(label)}`} />}
      {data && data.critical.length > 0 && (
        <div className="ab-chips" aria-label="Most critical times">
          <span className="ab-sub">Most critical:</span>
          {data.critical.map((x) => (
            <button key={x} type="button" className="ab-chip" aria-pressed={x === t} onClick={() => { setChosen({ id: scenarioId, t: x }); setLimit(PAGE); }}>{utc(x)}</button>
          ))}
        </div>
      )}
      {t !== null && (
        <div className="mt-3 grid gap-3">
          <p className="across-card__hint">
            {utc(t)} UTC · {shown ? `${shown.total} elements · ${shown.violations} beyond their limit` : 'loading …'}
            {shown && (shown.in_window ? ' · inside the outage window' : ' · outside the outage window')}
          </p>
          {mapVisible && (
            <Suspense fallback={<div className="ab-empty" aria-busy>Loading network map …</div>}>
              <NetworkMap scenarioId={scenarioId} t={t} onPickAsset={onPickAsset} />
            </Suspense>
          )}
          {distributionOption && <ReactECharts echarts={echarts} option={distributionOption} notMerge style={{ height: 200 }} exportName={`distribution-${fileSafe(label)}-${t}`} />}
          {shown && (
            <div className="ab-scroll">
              <table className="ab-table">
                <thead>
                  <tr>
                    <th>Element</th><th>Grid</th><th className="ab-num">kV</th><th className="ab-num">REF</th>
                    <th className="ab-num">Scenario</th><th className="ab-num">Δ</th><th className="ab-num">Limit</th><th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.rows.map((r) => (
                    <tr key={r.element_id}>
                      <td><div className="ab-linename" title={r.class_name ?? undefined}>{r.name}</div></td>
                      <td>{r.grid || '–'}</td>
                      <td className="ab-num">{r.nominal_kv ?? '–'}</td>
                      <td className="ab-num">{fmt(metric, r.ref)}</td>
                      <td className="ab-num">{fmt(metric, r.value)}</td>
                      <td className="ab-num">{r.delta === null ? '–' : metric === 'loading' ? `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(1)} pp` : `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(3)}`}</td>
                      <td className="ab-num">{metric === 'loading' ? fmt(metric, r.upper) : `${fmt(metric, r.lower)} … ${fmt(metric, r.upper)}`}</td>
                      <td>{r.state === 'value' ? '' : r.state === 'outaged' ? 'switched off' : 'no valid value'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {shown && (
            <div className="ab-chips">
              {shown.rows.length < shown.total && (
                <button type="button" className="ab-chip" onClick={() => setLimit((n) => n + PAGE)}>Show {Math.min(PAGE, shown.total - shown.rows.length)} more of {shown.total - shown.rows.length}</button>
              )}
              <button type="button" className="ab-chip" onClick={() => { void exportCsv(); }} title="Every element at this time as CSV">CSV</button>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
});
