import { useMemo, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, ScatterChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import ReactECharts from '../charts/ReactECharts';
import { useChartTheme } from '../../hooks/useChartTheme';
import { ANALYSIS, BAND_ORDER, LOADING_LIMITS, LOADING_BANDS, bandOf, type BandId } from '../../config/loadingBands';
import { escapeHtml, readAcrossColors, withAlpha } from '../../util/acrossColors';
import {
  fmtHours,
  fmtLodf,
  fmtNum,
  fmtPct,
  fmtPp,
  fmtShare,
  type LineStats,
  type ScenarioStats,
} from '../../util/acrossScenarios';
import { SectionCard } from './shared';
import { lodfStatus } from '../../util/lodfStatus';

echarts.use([BarChart, ScatterChart, DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);

const TOP = 12;
const ROW = 28;
/** Room for a zoom slider next to the plot area. */
const ZOOM_SPACE = 22;

function zoomSlider(theme: ReturnType<typeof useAcrossTheme>['theme']) {
  return {
    type: 'slider' as const,
    filterMode: 'none' as const,
    showDetail: false,
    brushSelect: false,
    borderColor: theme.axis,
    backgroundColor: 'transparent',
    fillerColor: withAlpha(theme.mutedText, 0.18),
    dataBackground: { lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 } },
    selectedDataBackground: { lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 } },
    handleStyle: { color: theme.mutedText, borderColor: theme.text },
    moveHandleStyle: { color: theme.mutedText },
    textStyle: { color: theme.mutedText },
  };
}

interface Props {
  lines: LineStats[];
  scenarios: ScenarioStats[];
  periodHours: number;
  hasLodf: boolean;
}

function useAcrossTheme() {
  const theme = useChartTheme();
  const colors = useMemo(() => readAcrossColors(theme.isLight), [theme.isLight]);
  return { theme, colors };
}

const common = (theme: ReturnType<typeof useChartTheme>) => ({
  backgroundColor: 'transparent',
  textStyle: { color: theme.mutedText, fontSize: 11 },
  tooltip: {
    backgroundColor: theme.tooltipBg,
    borderColor: theme.tooltipBorder,
    textStyle: { color: theme.text, fontSize: 12 },
    extraCssText: 'max-width: 340px; white-space: normal;',
  },
});

const yCategory = (theme: ReturnType<typeof useChartTheme>, names: string[], edge = false) => ({
  type: 'category' as const,
  inverse: true,
  data: names,
  axisTick: { show: false },
  axisLine: { lineStyle: { color: theme.axis }, ...(edge ? { onZero: false } : {}) },
  axisLabel: { color: theme.text, fontSize: 11, width: 150, overflow: 'truncate' as const },
});

const xValue = (theme: ReturnType<typeof useChartTheme>, unit: string, extra: object = {}) => ({
  type: 'value' as const,
  // Rounded and without overlaps: a zoomed axis starts and ends at arbitrary values.
  axisLabel: { color: theme.mutedText, fontSize: 10, hideOverlap: true, formatter: (v: number) => `${Math.round(v * 10) / 10}${unit}` },
  axisLine: { show: false },
  splitLine: { lineStyle: { color: theme.grid } },
  ...extra,
});

const scenarioName = (scenarios: ScenarioStats[], id: string | null) => {
  const s = scenarios.find((x) => x.scenario.id === id);
  return s ? `${s.code} · ${s.scenario.name}` : '–';
};

/** Base → maximum loading per line on top of the loading bands. */
export function LoadingRangeChart({ lines, scenarios, top = TOP }: { lines: LineStats[]; scenarios: ScenarioStats[]; top?: number }) {
  const { theme, colors } = useAcrossTheme();
  const rows = useMemo(() => [...lines].filter((s) => s.max !== null).sort((a, b) => b.priority - a.priority).slice(0, top), [lines, top]);
  const option = useMemo(() => {
    const names = rows.map((r) => r.line.name);
    const max = Math.ceil(Math.max(LOADING_LIMITS.severe + 10, ...rows.map((r) => (r.max ?? 0) + 8)) / 10) * 10;
    const bounds = [0, LOADING_LIMITS.warning, LOADING_LIMITS.overload, LOADING_LIMITS.clear, LOADING_LIMITS.severe, max];
    const alpha: Record<BandId, number> = { ok: 0.06, high: 0.16, light: 0.2, clear: 0.24, severe: 0.28 };
    return {
      ...common(theme),
      tooltip: {
        ...common(theme).tooltip,
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: { dataIndex: number }[]) => {
          const r = rows[params[0]?.dataIndex ?? 0];
          if (!r) return '';
          return [
            `<strong>${escapeHtml(r.line.name)}</strong>`,
            `Base (REF-Maximum): ${fmtPct(r.base)}`,
            `Max Loading: <strong>${fmtPct(r.max)}</strong> · ${escapeHtml(scenarioName(scenarios, r.maxScenarioId))}`,
            `Min Loading: ${fmtPct(r.min)}`,
            `Scenarios &gt; 100 %: ${r.n100}`,
          ].join('<br/>');
        },
      },
      grid: { left: 8, right: 64 + ZOOM_SPACE, top: 8, bottom: 24 + ZOOM_SPACE, containLabel: true },
      xAxis: xValue(theme, ' %', { min: 0, max }),
      yAxis: yCategory(theme, names),
      // Zoomable on both axes: sliders below (loading) and on the right (equipment), drag inside the chart to move,
      // Ctrl + mouse wheel to zoom (the plain wheel keeps scrolling the page).
      dataZoom: [
        { type: 'inside' as const, xAxisIndex: 0, filterMode: 'none' as const, zoomOnMouseWheel: 'ctrl' as const, moveOnMouseWheel: false },
        { type: 'inside' as const, yAxisIndex: 0, filterMode: 'none' as const, zoomOnMouseWheel: 'ctrl' as const, moveOnMouseWheel: false },
        { ...zoomSlider(theme), xAxisIndex: 0, bottom: 4, height: 14 },
        { ...zoomSlider(theme), yAxisIndex: 0, right: 4, width: 14 },
      ],
      series: [
        {
          type: 'bar', stack: 'range', silent: true, barWidth: 6, itemStyle: { color: 'transparent' },
          data: rows.map((r) => Math.min(r.base ?? r.max ?? 0, r.max ?? 0)),
          markArea: {
            silent: true,
            data: BAND_ORDER.map((id, i) => [
              { xAxis: bounds[i], itemStyle: { color: withAlpha(colors.bands[id], alpha[id]) } },
              { xAxis: bounds[i + 1] },
            ]),
          },
        },
        {
          type: 'bar', stack: 'range', barWidth: 6,
          data: rows.map((r) => ({
            value: Math.abs((r.max ?? 0) - (r.base ?? r.max ?? 0)),
            itemStyle: { color: colors.bands[bandOf(r.max ?? 0).id], borderRadius: 3 },
          })),
        },
        {
          type: 'scatter', name: 'Base', symbol: 'circle', symbolSize: 9, z: 4,
          itemStyle: { color: theme.isLight ? '#ffffff' : '#0b0f14', borderColor: theme.mutedText, borderWidth: 2 },
          data: rows.map((r) => ({ value: [r.base ?? r.max ?? 0, r.line.name] })),
        },
        {
          type: 'scatter', name: 'Max', symbol: 'circle', symbolSize: 12, z: 5,
          label: { show: true, position: 'right', color: theme.text, fontSize: 11, fontWeight: 600, formatter: (p: { value: number[] }) => fmtNum(p.value[0]) },
          data: rows.map((r) => ({ value: [r.max ?? 0, r.line.name], itemStyle: { color: colors.bands[bandOf(r.max ?? 0).id] } })),
        },
      ],
    };
  }, [rows, theme, colors, scenarios]);
  if (rows.length === 0) return <div className="ab-empty">No loading values available.</div>;
  return <ReactECharts echarts={echarts} option={option} notMerge style={{ height: rows.length * ROW + 40 + ZOOM_SPACE }} />;
}

/** Time above the limits, as share of the simulation period (worst scenario per line). */
export function OverloadTimeChart({ lines, scenarios, periodHours, top = TOP }: { lines: LineStats[]; scenarios: ScenarioStats[]; periodHours: number; top?: number }) {
  const { theme, colors } = useAcrossTheme();
  const rows = useMemo(() => [...lines].filter((s) => s.overloadHours > 0).sort((a, b) => b.overloadHours - a.overloadHours).slice(0, top), [lines, top]);
  const option = useMemo(() => {
    const names = rows.map((r) => r.line.name);
    const pct = (h: number) => (periodHours > 0 ? (h / periodHours) * 100 : 0);
    const seg = (pick: (r: LineStats) => number, id: BandId) => ({
      type: 'bar' as const, stack: 'time', barWidth: 12, name: LOADING_BANDS.find((b) => b.id === id)!.range.replace('%', '').trim() + ' %',
      itemStyle: { color: colors.bands[id] }, data: rows.map((r) => pct(pick(r))),
    });
    return {
      ...common(theme),
      legend: { top: 0, right: 0, itemWidth: 10, itemHeight: 10, textStyle: { color: theme.mutedText, fontSize: 11 } },
      tooltip: {
        ...common(theme).tooltip,
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: { dataIndex: number }[]) => {
          const r = rows[params[0]?.dataIndex ?? 0];
          if (!r) return '';
          const [a, b, c] = r.overloadHoursBands;
          return [
            `<strong>${escapeHtml(r.line.name)}</strong> · ${escapeHtml(scenarioName(scenarios, r.overloadScenarioId))}`,
            `Overload Rate: <strong>${fmtShare(r.overloadShare)}</strong> of the simulation period`,
            `&gt; 100 %: ${fmtHours(a)} · &gt; 110 %: ${fmtHours(b)} · &gt; 120 %: ${fmtHours(c)}`,
            `Simulation period: ${fmtHours(periodHours)}`,
          ].join('<br/>');
        },
      },
      grid: { left: 8, right: 96, top: 28, bottom: 22, containLabel: true },
      xAxis: xValue(theme, ' %', { min: 0 }),
      yAxis: yCategory(theme, names),
      series: [
        seg((r) => r.overloadHoursBands[0] - r.overloadHoursBands[1], 'light'),
        seg((r) => r.overloadHoursBands[1] - r.overloadHoursBands[2], 'clear'),
        seg((r) => r.overloadHoursBands[2], 'severe'),
        {
          type: 'scatter', symbolSize: 0, silent: true, tooltip: { show: false },
          label: { show: true, position: 'right', color: theme.text, fontSize: 11, fontWeight: 600, formatter: (p: { dataIndex: number }) => `${fmtShare(rows[p.dataIndex].overloadShare)} · ${fmtHours(rows[p.dataIndex].overloadHours)}` },
          data: rows.map((r) => ({ value: [pct(r.overloadHours), r.line.name] })),
        },
      ],
    };
  }, [rows, theme, colors, scenarios, periodHours]);
  if (rows.length === 0) return <div className="ab-empty">No line exceeds 100 % in the simulation period.</div>;
  return <ReactECharts echarts={echarts} option={option} notMerge style={{ height: rows.length * ROW + 64 }} />;
}

/** Largest changes of loading against REF in the same window, both directions. */
export function DeltaChart({ lines, scenarios, top = TOP }: { lines: LineStats[]; scenarios: ScenarioStats[]; top?: number }) {
  const { theme, colors } = useAcrossTheme();
  const rows = useMemo(() => [...lines].filter((s) => s.maxDelta !== null).sort((a, b) => Math.abs(b.maxDelta ?? 0) - Math.abs(a.maxDelta ?? 0)).slice(0, top), [lines, top]);
  const option = useMemo(() => {
    const names = rows.map((r) => r.line.name);
    const limit = Math.max(10, ...rows.map((r) => Math.abs(r.maxDelta ?? 0))) * 1.25;
    return {
      ...common(theme),
      tooltip: {
        ...common(theme).tooltip,
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: { dataIndex: number }[]) => {
          const r = rows[params[0]?.dataIndex ?? 0];
          if (!r) return '';
          return [
            `<strong>${escapeHtml(r.line.name)}</strong> · ${escapeHtml(scenarioName(scenarios, r.maxDeltaScenarioId))}`,
            `Δ Loading: <strong>${fmtPp(r.maxDelta)}</strong> against REF in the same window`,
            `Max Loading: ${fmtPct(r.max)}`,
            `Spread between scenarios: ${fmtPp(r.spread)}`,
          ].join('<br/>');
        },
      },
      grid: { left: 8, right: 56, top: 8, bottom: 24, containLabel: true },
      xAxis: xValue(theme, '', { min: -limit, max: limit, axisLabel: { color: theme.mutedText, fontSize: 10, formatter: (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}` }, name: 'pp', nameLocation: 'end', nameTextStyle: { color: theme.mutedText } }),
      yAxis: yCategory(theme, names, true),
      series: [{
        type: 'bar', barWidth: 12,
        markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: theme.mutedText, width: 1 }, data: [{ xAxis: 0 }] },
        label: { show: true, color: theme.text, fontSize: 11, fontWeight: 600, position: 'outside', formatter: (p: { value: number }) => fmtPp(p.value) },
        data: rows.map((r) => ({
          value: r.maxDelta,
          itemStyle: { color: (r.maxDelta ?? 0) >= 0 ? colors.pos : colors.neg, borderRadius: (r.maxDelta ?? 0) >= 0 ? [0, 3, 3, 0] : [3, 0, 0, 3] },
          label: { position: (r.maxDelta ?? 0) >= 0 ? 'right' : 'left' },
        })),
      }],
    };
  }, [rows, theme, colors, scenarios]);
  if (rows.length === 0) return <div className="ab-empty">No changes calculated.</div>;
  return <ReactECharts echarts={echarts} option={option} notMerge style={{ height: rows.length * ROW + 40 }} />;
}

/** Every line × scenario as a point: |LODF| against the change of loading, coloured by band. */
export function LodfChart({ lines, scenarios, hasLodf }: { lines: LineStats[]; scenarios: ScenarioStats[]; hasLodf: boolean }) {
  const { theme, colors } = useAcrossTheme();
  const points = useMemo(() => {
    const result: { x: number; y: number; value: number; line: string; scenario: string; band: BandId }[] = [];
    for (const s of lines) {
      for (const sc of scenarios) {
        const cell = s.line.cells[sc.scenario.id];
        if (!cell || cell.outaged || cell.lodf === null || cell.delta === null || cell.value === null) continue;
        result.push({ x: Math.abs(cell.lodf), y: cell.delta, value: cell.value, line: s.line.name, scenario: `${sc.code} · ${sc.scenario.name}`, band: bandOf(cell.value).id });
      }
    }
    return result;
  }, [lines, scenarios]);
  const option = useMemo(() => {
    const xMax = Math.max(0.5, ...points.map((p) => p.x)) * 1.1;
    const ys = points.map((p) => p.y);
    const yMax = Math.max(20, ...ys) * 1.15;
    const yMin = Math.min(0, ...ys) * 1.15;
    const labelled = new Set([...points.keys()].sort((a, b) => points[b].x * Math.abs(points[b].y) - points[a].x * Math.abs(points[a].y)).slice(0, 5));
    return {
      ...common(theme),
      tooltip: {
        ...common(theme).tooltip,
        trigger: 'item',
        formatter: (p: { dataIndex: number }) => {
          const d = points[p.dataIndex];
          return [
            `<strong>${escapeHtml(d.line)}</strong>`, escapeHtml(d.scenario),
            `|LODF|: <strong>${fmtLodf(d.x)}</strong>`, `Δ Loading: <strong>${fmtPp(d.y)}</strong>`, `Loading: ${fmtPct(d.value)}`,
          ].join('<br/>');
        },
      },
      grid: { left: 8, right: 16 + ZOOM_SPACE, top: 30, bottom: 36 + ZOOM_SPACE, containLabel: true },
      // Zoom on both axes: sliders, or Ctrl + mouse wheel inside the plot; drag inside to move.
      dataZoom: [
        { type: 'inside' as const, xAxisIndex: 0, filterMode: 'none' as const, zoomOnMouseWheel: 'ctrl' as const, moveOnMouseWheel: false },
        { type: 'inside' as const, yAxisIndex: 0, filterMode: 'none' as const, zoomOnMouseWheel: 'ctrl' as const, moveOnMouseWheel: false },
        { ...zoomSlider(theme), xAxisIndex: 0, bottom: 4, height: 14 },
        { ...zoomSlider(theme), yAxisIndex: 0, right: 4, width: 14 },
      ],
      xAxis: xValue(theme, '', { min: 0, max: xMax, name: '|LODF|', nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: theme.mutedText }, axisLabel: { color: theme.mutedText, fontSize: 10, formatter: (v: number) => fmtLodf(v) } }),
      yAxis: xValue(theme, '', { min: yMin, max: yMax, name: 'Δ Loading (pp)', nameTextStyle: { color: theme.mutedText, align: 'left' }, axisLabel: { color: theme.mutedText, fontSize: 10, formatter: (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}` } }),
      series: [{
        type: 'scatter', symbolSize: (_: unknown, p: { dataIndex: number }) => (points[p.dataIndex].value > LOADING_LIMITS.overload ? 13 : 8),
        markArea: {
          silent: true,
          itemStyle: { color: withAlpha(colors.lodf, 0.09) },
          label: { show: true, position: 'insideBottomRight', color: theme.mutedText, fontSize: 10, formatter: 'high LODF + large change' },
          data: [[{ xAxis: ANALYSIS.lodfNotable, yAxis: ANALYSIS.deltaStrongPp / 2 }, { xAxis: xMax, yAxis: yMax }]],
        },
        markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: theme.mutedText, width: 1 }, data: [{ yAxis: 0 }] },
        data: points.map((p, i) => ({
          value: [p.x, p.y],
          itemStyle: { color: colors.bands[p.band], opacity: 0.9, borderColor: theme.isLight ? '#ffffff' : '#0b0f14', borderWidth: 1 },
          label: { show: labelled.has(i), position: 'top', color: theme.text, fontSize: 10, formatter: p.line },
        })),
      }],
    };
  }, [points, theme, colors]);
  if (!hasLodf) return <div className="ab-empty">{lodfStatus(scenarios.map((s) => s.scenario))?.text ?? 'No LODF for the scenarios shown.'}</div>;
  if (points.length === 0) return <div className="ab-empty">No points with LODF and change available.</div>;
  return <ReactECharts echarts={echarts} option={option} notMerge style={{ height: 360 + ZOOM_SPACE }} />;
}

/** Equipment shown at once in the LODF bars; the rest is reached by zooming. */
const LODF_VISIBLE = 15;

/** The LODF of every line for the outage of one scenario, largest |LODF| first; zoom to reach the small ones. */
export function LodfBarsChart({ lines, scenarios, hasLodf }: { lines: LineStats[]; scenarios: ScenarioStats[]; hasLodf: boolean }) {
  const { theme, colors } = useAcrossTheme();
  const best = useMemo(
    () => scenarios.reduce<ScenarioStats | null>((a, b) => ((b.maxAbsLodf ?? -1) > (a?.maxAbsLodf ?? -1) ? b : a), null),
    [scenarios],
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const scenario = scenarios.find((s) => s.scenario.id === chosen) ?? best;
  const rows = useMemo(() => {
    if (!scenario) return [];
    const result: { name: string; lodf: number; delta: number | null; value: number | null }[] = [];
    for (const s of lines) {
      const cell = s.line.cells[scenario.scenario.id];
      if (cell && !cell.outaged && cell.lodf !== null) result.push({ name: s.line.name, lodf: cell.lodf, delta: cell.delta, value: cell.value });
    }
    return result.sort((a, b) => Math.abs(b.lodf) - Math.abs(a.lodf));
  }, [lines, scenario]);
  const option = useMemo(() => {
    const limit = Math.max(0.1, ...rows.map((r) => Math.abs(r.lodf))) * 1.2;
    const shown = Math.min(100, (LODF_VISIBLE / Math.max(rows.length, 1)) * 100);
    return {
      ...common(theme),
      tooltip: {
        ...common(theme).tooltip,
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: { dataIndex: number }[]) => {
          const r = rows[params[0]?.dataIndex ?? 0];
          if (!r) return '';
          return [
            `<strong>${escapeHtml(r.name)}</strong>`,
            `LODF: <strong>${r.lodf > 0 ? '+' : ''}${fmtLodf(r.lodf)}</strong> (share of the lost flow it takes over; the sign is the direction)`,
            `Loading: ${fmtPct(r.value)} · Δ Loading: ${fmtPp(r.delta)}`,
          ].join('<br/>');
        },
      },
      grid: { left: 8, right: 56 + ZOOM_SPACE, top: 8, bottom: 24, containLabel: true },
      xAxis: xValue(theme, '', {
        min: -limit, max: limit, name: 'LODF', nameLocation: 'end', nameTextStyle: { color: theme.mutedText },
        axisLabel: { color: theme.mutedText, fontSize: 10, hideOverlap: true, formatter: (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100) / 100}` },
      }),
      yAxis: yCategory(theme, rows.map((r) => r.name), true),
      // The rows are many: the slider on the right moves through them, Ctrl + mouse wheel zooms, dragging inside moves.
      dataZoom: [
        { type: 'inside' as const, yAxisIndex: 0, filterMode: 'none' as const, start: 0, end: shown, zoomOnMouseWheel: 'ctrl' as const, moveOnMouseWheel: false },
        { type: 'inside' as const, xAxisIndex: 0, filterMode: 'none' as const, zoomOnMouseWheel: 'ctrl' as const, moveOnMouseWheel: false },
        { ...zoomSlider(theme), yAxisIndex: 0, start: 0, end: shown, right: 4, width: 14 },
      ],
      series: [{
        type: 'bar', barWidth: 12,
        markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: theme.mutedText, width: 1 }, data: [{ xAxis: 0 }] },
        label: { show: true, color: theme.text, fontSize: 11, fontWeight: 600, formatter: (p: { value: number }) => `${p.value > 0 ? '+' : ''}${fmtLodf(p.value)}` },
        data: rows.map((r) => ({
          value: r.lodf,
          itemStyle: { color: r.lodf >= 0 ? colors.pos : colors.neg, borderRadius: r.lodf >= 0 ? [0, 3, 3, 0] : [3, 0, 0, 3] },
          label: { position: r.lodf >= 0 ? 'right' : 'left' },
        })),
      }],
    };
  }, [rows, theme, colors]);
  if (!hasLodf) return <div className="ab-empty">{lodfStatus(scenarios.map((s) => s.scenario))?.text ?? 'No LODF for the scenarios shown.'}</div>;
  if (!scenario || rows.length === 0) return <div className="ab-empty">This scenario has no LODF values.</div>;
  return (
    <div className="grid gap-2">
      <label className="ab-toolbar" style={{ justifyContent: 'flex-start', gap: 8 }}>
        <span className="text-xs text-[var(--grid-muted)]">Outage</span>
        <select className="ab-control" aria-label="Scenario" value={scenario.scenario.id} onChange={(e) => setChosen(e.target.value)}>
          {scenarios.map((s) => <option key={s.scenario.id} value={s.scenario.id}>{`${s.code} · ${s.scenario.name}${s.scenario.has_lodf ? '' : ' (no LODF)'}`}</option>)}
        </select>
        <span className="text-xs text-[var(--grid-muted)]">{rows.length} lines</span>
      </label>
      <ReactECharts echarts={echarts} option={option} notMerge style={{ height: Math.min(rows.length, LODF_VISIBLE) * ROW + 40 }} />
    </div>
  );
}

export default function AcrossCharts({ lines, scenarios, periodHours, hasLodf }: Props) {
  return (
    <div className="ab-charts">
      <SectionCard title="Highest loading per equipment" hint="Base (REF) → maximum over all scenarios on the loading bands. The most conspicuous equipment. Zoom with the sliders or Ctrl + mouse wheel; drag to move.">
        <LoadingRangeChart lines={lines} scenarios={scenarios} />
      </SectionCard>
      <SectionCard title="Overload duration (overload rate)" hint="Time above 100 % in the worst scenario, relative to the simulation period.">
        <OverloadTimeChart lines={lines} scenarios={scenarios} periodHours={periodHours} />
      </SectionCard>
      <SectionCard title="Change of loading" hint="Largest change against REF in the same outage window in percentage points (pp): relief on the left, additional load on the right.">
        <DeltaChart lines={lines} scenarios={scenarios} />
      </SectionCard>
      <SectionCard title="LODF per line of one outage" hint="How much of the flow of the switched-off equipment each line takes over (signed: the sign is the direction of the change). Largest first; zoom with the slider on the right or Ctrl + mouse wheel, drag to move.">
        <LodfBarsChart lines={lines} scenarios={scenarios} hasLodf={hasLodf} />
      </SectionCard>
      <SectionCard title="LODF and change of loading" hint="Each point is a line in one scenario. Top right: high |LODF| with a large additional load. Colour = loading band. Zoom with the sliders or Ctrl + mouse wheel; drag to move.">
        <LodfChart lines={lines} scenarios={scenarios} hasLodf={hasLodf} />
      </SectionCard>
    </div>
  );
}
