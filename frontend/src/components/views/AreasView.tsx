import { memo, useEffect, useMemo, useState } from 'react';
import * as echarts from 'echarts/core';
import { GraphChart, HeatmapChart, LineChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, TooltipComponent, VisualMapComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { getAreas, type AreaRow, type AreaView } from '../../api/areas';
import { utc } from '../../api/views';
import ReactECharts from '../charts/ReactECharts';
import { useChartTheme } from '../../hooks/useChartTheme';
import { useGridFilter } from '../../hooks/useGridFilter';
import { useTimeRange } from '../../hooks/useTimeRange';
import { readAcrossColors, withAlpha } from '../../util/acrossColors';
import { SUMMARY_IDS } from '../../util/acrossScenarios';
import { downloadText, fileSafe, toCsv } from '../../util/csv';
import { SectionCard } from '../across/shared';

echarts.use([LineChart, GraphChart, HeatmapChart, GridComponent, LegendComponent, TooltipComponent, MarkAreaComponent,
  DataZoomComponent, VisualMapComponent, CanvasRenderer]);

const mw = (v: number | null | undefined, signed = false) =>
  v === null || v === undefined || !Number.isFinite(v) ? '–' : `${signed && v > 0 ? '+' : ''}${Math.round(v).toLocaleString('en-GB')} MW`;

/** The area to show first: the one that has to import most. */
const neediest = (areas: AreaRow[]) => [...areas].sort((a, b) => (a.net_min ?? 0) - (b.net_min ?? 0))[0]?.area ?? null;

/**
 * Load, generation and transit per area (grid) of a scenario against REF: which areas consume, which feed in, how
 * much power flows between them and which areas mainly pass power on. Needs the active power PowerFactory
 * recorded; without it the widget says which variables are missing instead of showing numbers.
 */
export default memo(function AreasView({ scenarioId, label, refreshKey }: { scenarioId: string; label: string; refreshKey: number }) {
  const theme = useChartTheme();
  const colors = useMemo(() => readAcrossColors(theme.isLight), [theme.isLight]);
  const range = useTimeRange();
  const key = `${scenarioId}|${range.from}|${range.to}|${refreshKey}`;
  const [view, setView] = useState<{ key: string; data: AreaView } | null>(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getAreas(scenarioId, range, controller.signal)
      .then((data) => { setView({ key, data }); setError(''); })
      .catch(() => { if (!controller.signal.aborted) setError('Load, generation and transit could not be loaded.'); });
    return () => controller.abort();
  }, [key, scenarioId, range]);

  const loaded = view?.key === key ? view.data : null;
  // The header's grid filter: an area is a grid, so only that area, its course and the flows touching it remain.
  const { grid, kv } = useGridFilter();
  const data = useMemo(() => {
    if (!loaded || grid === null) return loaded;
    const keep = <T,>(record: Record<string, T> | undefined) => (record && grid in record ? { [grid]: record[grid] } : {});
    return {
      ...loaded, areas: (loaded.areas ?? []).filter((a) => a.area === grid), course: keep(loaded.course), daily: keep(loaded.daily),
      flows: (loaded.flows ?? []).filter((f) => f.from === grid || f.to === grid),
    };
  }, [loaded, grid]);
  const areas = useMemo(() => data?.areas ?? [], [data]);
  const area = picked && areas.some((a) => a.area === picked) ? picked : neediest(areas);
  const { axis, tooltip } = useMemo(() => ({
    axis: { axisLabel: { color: theme.mutedText, fontSize: 10 }, axisLine: { lineStyle: { color: theme.axis } } },
    tooltip: { backgroundColor: theme.tooltipBg, borderColor: theme.tooltipBorder, textStyle: { color: theme.text, fontSize: 12 } },
  }), [theme]);
  const exportColor = colors.bands.ok;
  const importColor = colors.bands.clear;

  // Generation above zero, load below, net as a band (lowest and highest of each interval).
  const balanceOption = useMemo(() => {
    const course = area ? data?.course?.[area] : undefined;
    if (!data?.times || !course) return null;
    const stamps = data.times.map((t) => t * 1000);
    const pairs = (values: (number | null)[], sign = 1) => values.map((v, i) => [stamps[i], v === null ? null : sign * v]);
    return {
      backgroundColor: 'transparent', textStyle: { color: theme.mutedText, fontSize: 11 },
      legend: { top: 0, textStyle: { color: theme.text, fontSize: 11 } },
      tooltip: { trigger: 'axis', ...tooltip, valueFormatter: (v: unknown) => mw(typeof v === 'number' ? v : null) },
      grid: { left: 8, right: 16, top: 30, bottom: 44, containLabel: true },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 14, bottom: 6 }],
      xAxis: { type: 'time', ...axis },
      yAxis: { type: 'value', ...axis, axisLabel: { ...axis.axisLabel, formatter: '{value} MW' }, splitLine: { lineStyle: { color: theme.grid } } },
      series: [
        { type: 'line', name: 'Generation', showSymbol: false, sampling: 'lttb', data: pairs(course.generation),
          lineStyle: { color: exportColor, width: 1.2 }, itemStyle: { color: exportColor }, areaStyle: { color: withAlpha(exportColor, 0.25) },
          markArea: { silent: true, itemStyle: { color: withAlpha(colors.lodf, theme.isLight ? 0.08 : 0.14) },
            data: (data.windows ?? []).map(([a, b]) => [{ xAxis: a * 1000 }, { xAxis: b * 1000 }]) } },
        { type: 'line', name: 'Load (negative)', showSymbol: false, sampling: 'lttb', data: pairs(course.load, -1),
          lineStyle: { color: importColor, width: 1.2 }, itemStyle: { color: importColor }, areaStyle: { color: withAlpha(importColor, 0.25) } },
        { type: 'line', name: 'Net (export +)', showSymbol: false, data: pairs(course.net_max),
          lineStyle: { color: theme.text, width: 1.6 }, itemStyle: { color: theme.text } },
        ...(data.interval_steps && data.interval_steps > 1
          ? [{ type: 'line', name: 'Net, lowest', showSymbol: false, data: pairs(course.net_min),
            lineStyle: { color: theme.text, width: 1, type: 'dashed' }, itemStyle: { color: theme.text } }]
          : []),
      ],
    };
  }, [data, area, theme, colors, exportColor, importColor, axis, tooltip]);

  // Areas as nodes (size: mean load, colour: export or import), arrows for the mean flow between them.
  const flowOption = useMemo(() => {
    if (!data?.capability.flows || !data.flows?.length) return null;
    const loads = areas.map((a) => a.load_mean ?? 0);
    const biggest = Math.max(1, ...loads);
    const strongest = Math.max(1, ...data.flows.map((f) => Math.abs(f.mean)));
    return {
      backgroundColor: 'transparent',
      tooltip: { ...tooltip, formatter: (p: { dataType: string; data: { tip?: string } }) => p.data.tip ?? '' },
      series: [{
        type: 'graph', layout: 'circular', roam: true, edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 10,
        label: { show: true, color: theme.text, fontSize: 12, position: 'bottom' },
        edgeLabel: { show: true, color: theme.mutedText, fontSize: 11, formatter: (p: { data: { text: string } }) => p.data.text },
        data: areas.map((a) => ({
          name: a.area, symbolSize: 30 + 40 * Math.sqrt((a.load_mean ?? 0) / biggest),
          itemStyle: { color: (a.net_mean ?? 0) >= 0 ? exportColor : importColor },
          tip: `${a.area}<br/>Load ${mw(a.load_mean)} · generation ${mw(a.generation_mean)}<br/>Net ${mw(a.net_mean, true)} (mean)`,
        })),
        links: data.flows.map((f) => {
          const [source, target] = f.mean >= 0 ? [f.from, f.to] : [f.to, f.from];
          return {
            source, target, text: mw(Math.abs(f.mean)),
            lineStyle: { width: 1.5 + 8 * Math.abs(f.mean) / strongest, color: theme.mutedText, curveness: 0.15 },
            tip: `${source} → ${target}: ${mw(Math.abs(f.mean))} mean, strongest ${mw(Math.abs(f.peak))} `
              + `(${f.peak >= 0 ? `${f.from} → ${f.to}` : `${f.to} → ${f.from}`}); `
              + `${Math.round(100 * (f.mean >= 0 ? f.share_forward : 1 - f.share_forward))} % of the time in this direction`,
          };
        }),
      }],
    };
  }, [data, areas, theme, exportColor, importColor, tooltip]);

  const transitOption = useMemo(() => {
    if (!data?.capability.flows || !data.times || !data.course) return null;
    const stamps = data.times.map((t) => t * 1000);
    return {
      backgroundColor: 'transparent', textStyle: { color: theme.mutedText, fontSize: 11 },
      legend: { top: 0, type: 'scroll', textStyle: { color: theme.text, fontSize: 11 } },
      tooltip: { trigger: 'axis', ...tooltip, valueFormatter: (v: unknown) => mw(typeof v === 'number' ? v : null) },
      grid: { left: 8, right: 16, top: 30, bottom: 44, containLabel: true },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 14, bottom: 6 }],
      xAxis: { type: 'time', ...axis },
      yAxis: { type: 'value', ...axis, axisLabel: { ...axis.axisLabel, formatter: '{value} MW' }, splitLine: { lineStyle: { color: theme.grid } } },
      series: Object.entries(data.course).map(([name, c]) => ({
        type: 'line', name, showSymbol: false, sampling: 'lttb', data: c.transit.map((v, i) => [stamps[i], v]),
      })),
    };
  }, [data, theme, axis, tooltip]);

  const heatOption = useMemo(() => {
    if (!data?.days || !data.daily) return null;
    const names = Object.keys(data.daily);
    const cells: [number, number, number | null][] = [];
    let extreme = 1;
    names.forEach((name, row) => data.daily![name].net_mean.forEach((v, day) => {
      cells.push([day, row, v === null ? null : Math.round(v)]);
      if (v !== null) extreme = Math.max(extreme, Math.abs(v));
    }));
    const days = data.days.map((d) => new Date(d * 1000).toISOString().slice(5, 10));
    return {
      backgroundColor: 'transparent',
      tooltip: { ...tooltip, formatter: (p: { value: [number, number, number | null] }) => {
        const [day, row, value] = p.value;
        const d = data.daily![names[row]];
        return `${names[row]} · ${days[day]}<br/>Net ${mw(value, true)} (mean), ${mw(d.net_min[day], true)} … ${mw(d.net_max[day], true)}<br/>Highest load ${mw(d.load_max[day])}`;
      } },
      grid: { left: 8, right: 16, top: 8, bottom: 56, containLabel: true },
      xAxis: { type: 'category', data: days, ...axis, splitArea: { show: false } },
      yAxis: { type: 'category', data: names, ...axis },
      visualMap: { min: -extreme, max: extreme, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 120,
        text: ['export', 'import'], textStyle: { color: theme.mutedText, fontSize: 10 },
        inRange: { color: [importColor, theme.isLight ? '#f4f4f5' : '#27272a', exportColor] } },
      series: [{ type: 'heatmap', data: cells, emphasis: { itemStyle: { borderColor: theme.text, borderWidth: 1 } } }],
    };
  }, [data, theme, exportColor, importColor, axis, tooltip]);

  const exportCsv = () => {
    downloadText(`areas-${fileSafe(label)}.csv`, toCsv(
      ['Area', 'Load mean MW', 'Load peak MW', 'Generation mean MW', 'Net mean MW', 'Peak import MW', 'Peak export MW',
        'Peak transit MW', 'REF peak import MW'],
      areas.map((a) => [a.area, a.load_mean, a.load_peak, a.generation_mean, a.net_mean, a.import_peak, a.export_peak,
        a.transit_peak, a.ref?.import_peak ?? null])));
  };

  const capability = data?.capability;
  return (
    <SectionCard
      id={SUMMARY_IDS.areas}
      title={`Areas: load, generation and transit · ${label}`}
      hint="Per area (grid): what it consumes and feeds in, its balance (export positive, import negative), the power flowing between areas and what an area only passes on (transit: the smaller of import and export). Scenario against REF; the time range of the toolbar applies. Built from the active power recorded in PowerFactory."
      actions={areas.length > 0 ? <button type="button" className="ab-chip" onClick={exportCsv}>CSV</button> : undefined}
    >
      {error && <div className="ab-empty" role="alert">{error}</div>}
      {!data && !error && <div className="ab-empty" aria-busy>Loading areas …</div>}
      {capability && !capability.balance && (
        <div className="ab-unavailable" role="status">
          <b>Cannot evaluate load, generation and transit for this run.</b>
          {capability.missing.length > 0 && (
            <>
              <p>PowerFactory did not record:</p>
              <ul>{capability.missing.map((m) => <li key={m}>{m}</li>)}</ul>
              <p>Select them in ComStatsim → Result Variables and calculate again; the dashboard then evaluates them.</p>
            </>
          )}
          {capability.notes.map((n) => <p key={n}>{n}</p>)}
        </div>
      )}
      {capability?.balance && (
        <div className="grid gap-3">
          {!capability.flows && (
            <p className="ab-sub" role="status">
              Flows between areas and transit cannot be evaluated: {[...capability.missing, ...capability.notes].join(' ') || 'no recorded branch connects two areas.'}
            </p>
          )}
          {(grid !== null || kv !== null) && (
            <p className="ab-sub" role="status">
              {grid !== null ? `Grid filter: only ${grid} and the flows touching it. ` : ''}
              {kv !== null ? 'The voltage-level filter does not apply here: an area balance sums every voltage level.' : ''}
            </p>
          )}
          <div className="ab-scroll">
            <table className="ab-table">
              <thead>
                <tr>
                  <th>Area</th><th className="ab-num">Load mean</th><th className="ab-num">Load peak</th>
                  <th className="ab-num">Generation mean</th><th className="ab-num">Net mean</th>
                  <th className="ab-num">Peak import</th><th className="ab-num">Peak export</th><th className="ab-num">Peak transit</th>
                  <th className="ab-num">Peak import REF</th>
                </tr>
              </thead>
              <tbody>
                {areas.map((a) => (
                  <tr key={a.area} aria-selected={a.area === area} onClick={() => setPicked(a.area)} className="ab-compare__row">
                    <td>{a.area}{a.missing_times > 0 && <span className="ab-sub">{a.missing_times} times with missing values</span>}</td>
                    <td className="ab-num">{mw(a.load_mean)}</td>
                    <td className="ab-num">{mw(a.load_peak)}</td>
                    <td className="ab-num">{mw(a.generation_mean)}</td>
                    <td className="ab-num" style={{ color: (a.net_mean ?? 0) >= 0 ? exportColor : importColor }}>{mw(a.net_mean, true)}</td>
                    <td className="ab-num">{capability.flows ? mw(a.import_peak) : '–'}</td>
                    <td className="ab-num">{capability.flows ? mw(a.export_peak) : '–'}</td>
                    <td className="ab-num">{capability.flows ? mw(a.transit_peak) : '–'}</td>
                    <td className="ab-num">{capability.flows && a.ref ? mw(a.ref.import_peak) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ab-chips" aria-label="Area of the balance chart">
            <span className="ab-sub">Balance of</span>
            {areas.map((a) => (
              <button key={a.area} type="button" className="ab-chip" aria-pressed={a.area === area} onClick={() => setPicked(a.area)}>{a.area}</button>
            ))}
            {data?.interval_steps && data.interval_steps > 1 && <span className="ab-sub">highest values of every {data.interval_steps} hours</span>}
          </div>
          {balanceOption && <ReactECharts echarts={echarts} option={balanceOption} notMerge style={{ height: 260 }} exportName={`area-balance-${fileSafe(area ?? '')}`} />}
          <div className="ab-areas__pair">
            {flowOption && (
              <div>
                <h4 className="across-card__title">Flows between areas (mean{data?.times?.length ? ` ${utc(data.times[0])} – ${utc(data.times[data.times.length - 1])}` : ''})</h4>
                <ReactECharts echarts={echarts} option={flowOption} notMerge style={{ height: 300 }} exportName={`area-flows-${fileSafe(label)}`} />
              </div>
            )}
            {transitOption && (
              <div>
                <h4 className="across-card__title">Transit per area</h4>
                <ReactECharts echarts={echarts} option={transitOption} notMerge style={{ height: 300 }} exportName={`area-transit-${fileSafe(label)}`} />
              </div>
            )}
          </div>
          {heatOption && (
            <div>
              <h4 className="across-card__title">Net balance per area and day</h4>
              <ReactECharts echarts={echarts} option={heatOption} notMerge style={{ height: 70 + 34 * Object.keys(data!.daily!).length }} exportName={`area-days-${fileSafe(label)}`} />
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
});
