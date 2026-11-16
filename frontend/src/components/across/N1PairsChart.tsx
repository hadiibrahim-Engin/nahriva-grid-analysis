import { useEffect, useMemo, useState } from 'react';
import * as echarts from 'echarts/core';
import { CustomChart, SankeyChart, ScatterChart } from 'echarts/charts';
import { GridComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { utc, views, type N1Pair, type N1Pairs } from '../../api/views';
import { LOADING_LIMITS } from '../../config/loadingBands';
import ReactECharts from '../charts/ReactECharts';
import { useAcrossData } from '../../hooks/useAcrossData';
import { useChartTheme } from '../../hooks/useChartTheme';
import { useGridFilter } from '../../hooks/useGridFilter';
import { useTimeRange } from '../../hooks/useTimeRange';
import { readAcrossColors, type AcrossColors } from '../../util/acrossColors';
import { scenarioCode } from '../../util/acrossScenarios';
import type { DynamicChartConfig } from '../../util/dynamicCharts';

echarts.use([ScatterChart, CustomChart, SankeyChart, GridComponent, TooltipComponent, MarkLineComponent, CanvasRenderer]);

/** One of the two n-1 visualisations offered by the chart picker. */
type Kind = 'n1BeforeAfter' | 'n1Flow';
type Sweep = N1Pairs['kind'];
/** Pairs to show; ALL asks for every pair (the server caps at 100,000). */
const ALL = 100_000;
const TOPS = [10, 25, 50, ALL] as const;

const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v)} %`);

function band(value: number, colors: AcrossColors): string {
  const l = LOADING_LIMITS;
  return value >= l.severe ? colors.bands.severe : value > l.clear ? colors.bands.clear : value > l.overload
    ? colors.bands.light : value >= l.warning ? colors.bands.high : colors.bands.ok;
}

function tip(p: N1Pair, sweep: Sweep, before: string) {
  return `<b>${p.element}</b> (${p.grid})<br/>when <b>${p.contingency}</b> fails${sweep === "(n-1)'" ? ' (during the maintenance)' : ''}<br/>`
    + `${pct(p.pre)} before (${before}) → <b>${pct(p.post)}</b> after, at ${utc(p.t)} UTC<br/>`
    + `${p.hours_over.toLocaleString('en-GB')} h above the limit of ${pct(p.limit)}`;
}

/**
 * n-1 of one scenario as "which contingency overloads which branch": one row per pair with the loading
 * before and after the contingency (dumbbell), and/or a Sankey from the failing branches to the branches they
 * overload, the width the hours above the limit (or the highest loading). Reads the recorded n-1 cells of the
 * scenario's sweep; the time range of the toolbar applies.
 */
export default function N1PairsChart({ kind, config = { sourceKeys: [] } }: { kind: Kind; config?: DynamicChartConfig }) {
  const showDumbbell = kind === 'n1BeforeAfter';
  const showSankey = kind === 'n1Flow';
  const theme = useChartTheme();
  const colors = useMemo(() => readAcrossColors(theme.isLight), [theme.isLight]);
  const range = useTimeRange();
  const headerScope = useGridFilter();
  const grid = config.grid === undefined ? headerScope.grid : config.grid;
  const kv = config.kv === undefined ? headerScope.kv : config.kv;
  const equipment = config.equipment ?? 'all';
  const elementIds = useMemo(
    () => config.elementMode === 'selected' ? config.elementIds ?? [] : [],
    [config.elementMode, config.elementIds],
  );
  const elementKey = [...elementIds].sort().join(',');
  const { data } = useAcrossData(0);
  const scenarios = useMemo(() => {
    const all = (data?.scenarios ?? []).map((s, i) => ({ id: s.id, label: `${scenarioCode(i)} ${s.name}` }));
    const chosen = new Set(config.scenarioIds ?? []);
    return chosen.size ? all.filter((s) => chosen.has(s.id)) : all;
  }, [data, config.scenarioIds]);
  const [picked, setPicked] = useState<string | null>(null);
  const [sweep, setSweep] = useState<Sweep>("(n-1)'");
  const [top, setTop] = useState<number>(config.topN && config.topN > 0 ? config.topN : 25);
  const [width, setWidth] = useState<'hours' | 'loading'>('hours');
  useEffect(() => setTop(config.topN && config.topN > 0 ? config.topN : 25), [config.topN]);
  const scenario = picked && scenarios.some((s) => s.id === picked) ? picked : scenarios[0]?.id ?? null;
  const key = `${scenario}|${sweep}|${top}|${range.from}|${range.to}|${grid}|${kv}|${equipment}|${elementKey}`;
  const [result, setResult] = useState<{ key: string; data: N1Pairs | null; error: string } | null>(null);

  useEffect(() => {
    if (!scenario) return;
    const controller = new AbortController();
    views.n1Pairs(scenario, sweep, range, top, { grid, kv, equipment, elementIds }, controller.signal)
      .then((found) => setResult({ key, data: found, error: '' }))
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        const missing = (e as { response?: { status?: number } }).response?.status === 404;
        setResult({ key, data: null, error: missing ? 'This scenario has no such n-1 sweep.' : 'The n-1 results could not be loaded.' });
      });
    return () => controller.abort();
  }, [key, scenario, sweep, top, range, grid, kv, equipment, elementIds]);

  const shown = result?.key === key ? result : null;
  const pairs = useMemo(() => shown?.data?.pairs ?? [], [shown]);
  const before = shown?.data?.before ?? '';

  const dumbbell = useMemo(() => {
    if (!showDumbbell || pairs.length === 0) return null;
    const rows = [...pairs].reverse(); // worst at the top of a category axis
    const labels = rows.map((p) => `${p.element}  ←  ${p.contingency} fails`);
    const maxValue = Math.max(110, ...rows.map((p) => p.post)) * 1.08;
    return {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'item', backgroundColor: theme.tooltipBg, borderColor: theme.tooltipBorder, textStyle: { color: theme.text, fontSize: 12 },
        formatter: (p: { dataIndex: number }) => tip(rows[p.dataIndex], sweep, before) },
      grid: { left: 8, right: 70, top: 24, bottom: 30, containLabel: true },
      xAxis: { type: 'value', min: 0, max: Math.ceil(maxValue / 10) * 10, axisLabel: { color: theme.mutedText, fontSize: 10, formatter: '{value} %' },
        splitLine: { lineStyle: { color: theme.grid } } },
      yAxis: { type: 'category', data: labels, axisLabel: { color: theme.text, fontSize: 11 }, axisTick: { show: false },
        axisLine: { lineStyle: { color: theme.axis } } },
      series: [
        {
          type: 'custom', name: 'Change', silent: true, data: rows.map((p, i) => [p.pre ?? p.post, p.post, i]),
          renderItem: (_params: unknown, api: { value: (i: number) => number; coord: (v: [number, number]) => [number, number] }) => {
            const [x1, y] = api.coord([api.value(0), api.value(2)]);
            const [x2] = api.coord([api.value(1), api.value(2)]);
            return { type: 'line', shape: { x1, y1: y, x2, y2: y }, style: { stroke: theme.mutedText, lineWidth: 2, opacity: 0.6 } };
          },
          encode: { x: [0, 1], y: 2 },
        },
        {
          type: 'scatter', name: 'Before', symbolSize: 11, data: rows.map((p, i) => [p.pre, i]),
          itemStyle: { color: theme.isLight ? '#ffffff' : '#18181b', borderColor: theme.mutedText, borderWidth: 2 },
        },
        {
          type: 'scatter', name: 'After', symbolSize: 12,
          data: rows.map((p, i) => ({ value: [p.post, i], itemStyle: { color: band(p.post, colors) } })),
          label: { show: true, position: 'right', color: theme.mutedText, fontSize: 10,
            formatter: (p: { dataIndex: number }) => `${pct(rows[p.dataIndex].pre)} → ${pct(rows[p.dataIndex].post)}` },
          markLine: { silent: true, symbol: 'none', label: { formatter: `${LOADING_LIMITS.overload} %`, color: colors.bands.severe, fontSize: 10 },
            lineStyle: { color: colors.bands.severe, type: 'dashed' }, data: [{ xAxis: LOADING_LIMITS.overload }] },
        },
      ],
    };
  }, [showDumbbell, pairs, theme, colors, sweep, before]);

  const sankey = useMemo(() => {
    if (!showSankey || pairs.length === 0) return null;
    const outageNode = (name: string) => `⚡ ${name}`;
    const worst = new Map<string, number>();
    for (const p of pairs) worst.set(p.element, Math.max(worst.get(p.element) ?? 0, p.post));
    const nodes = [
      ...[...new Set(pairs.map((p) => p.contingency))].map((name) => ({ name: outageNode(name), itemStyle: { color: theme.mutedText } })),
      ...[...worst].map(([name, post]) => ({ name, itemStyle: { color: band(post, colors) } })),
    ];
    return {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'item', backgroundColor: theme.tooltipBg, borderColor: theme.tooltipBorder, textStyle: { color: theme.text, fontSize: 12 },
        formatter: (p: { dataType: string; data: { pair?: N1Pair; name?: string } }) =>
          p.dataType === 'edge' && p.data.pair ? tip(p.data.pair, sweep, before) : (p.data.name ?? '').replace('⚡ ', '') },
      series: [{
        type: 'sankey', left: 8, right: 120, top: 8, bottom: 8, nodeWidth: 12, nodeGap: 6, draggable: false,
        emphasis: { focus: 'adjacency' }, label: { color: theme.text, fontSize: 11 },
        lineStyle: { color: 'gradient', opacity: 0.35, curveness: 0.5 },
        data: nodes,
        links: pairs.map((p) => ({
          source: outageNode(p.contingency), target: p.element, pair: p,
          value: width === 'hours' ? Math.max(p.hours_over, 0.5) : Math.max(p.post - p.limit, 1),
        })),
      }],
    };
  }, [showSankey, pairs, theme, colors, width, sweep, before]);

  if (scenarios.length === 0) return <div className="ab-empty" aria-busy>Loading scenarios …</div>;
  const d = shown?.data;
  const side = new Set(pairs.map((p) => p.contingency)).size;
  const dumbbellHeight = 64 + 26 * pairs.length;
  const sankeyHeight = Math.max(320, 22 * Math.max(side, new Set(pairs.map((p) => p.element)).size));
  return (
    <div className="across-scope grid gap-2">
      <div className="ab-chips">
        <select className="ab-control" aria-label="Scenario" value={scenario ?? ''} onChange={(e) => setPicked(e.target.value)}>
          {scenarios.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <button type="button" className="ab-chip" aria-pressed={sweep === "(n-1)'"} onClick={() => setSweep("(n-1)'")}
          title="Contingencies during the planned outages of the scenario">During the maintenance</button>
        <button type="button" className="ab-chip" aria-pressed={sweep === 'n-1'} onClick={() => setSweep('n-1')}
          title="The same contingencies without the planned outages">Without maintenance</button>
        <span className="ab-sub">Top</span>
        {TOPS.map((n) => <button key={n} type="button" className="ab-chip" aria-pressed={top === n} onClick={() => setTop(n)}>{n === ALL ? 'All' : n}</button>)}
        {showSankey && (
          <>
            <span className="ab-sub">Width</span>
            <button type="button" className="ab-chip" aria-pressed={width === 'hours'} onClick={() => setWidth('hours')}>Hours above limit</button>
            <button type="button" className="ab-chip" aria-pressed={width === 'loading'} onClick={() => setWidth('loading')}>Loading above limit</button>
          </>
        )}
      </div>
      {!shown && <div className="ab-empty" aria-busy>Loading n-1 results …</div>}
      {shown?.error && <div className="ab-empty" role="status">{shown.error}</div>}
      {d && pairs.length === 0 && <div className="ab-empty">No contingency overloads a branch in this {sweep} sweep and time range.</div>}
      {d && pairs.length > 0 && (
        <p className="ab-sub">
          {d.total_pairs} pairs: {d.contingencies} contingencies overload {d.elements} branches
          {grid !== null || kv !== null ? ` in ${[grid, kv !== null ? `${kv} kV` : null].filter(Boolean).join(', ')}` : ''}
          {equipment !== 'all' ? ` · ${equipment}s only` : ''}
          {elementIds.length ? ` · ${elementIds.length} selected equipment item${elementIds.length === 1 ? '' : 's'}` : ''}
          {d.total_pairs > pairs.length ? ` · the ${pairs.length} worst shown` : ''} · before = {d.before}
        </p>
      )}
      {dumbbell && <ReactECharts echarts={echarts} option={dumbbell} notMerge style={{ height: dumbbellHeight }} exportName={`n1-before-after-${sweep}`} />}
      {sankey && <ReactECharts echarts={echarts} option={sankey} notMerge style={{ height: sankeyHeight }} exportName={`n1-flow-${sweep}`} />}
    </div>
  );
}
