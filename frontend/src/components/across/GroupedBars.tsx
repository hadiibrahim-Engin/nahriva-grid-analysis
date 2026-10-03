import { useMemo } from 'react';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import ReactECharts from '../charts/ReactECharts';
import { useChartTheme } from '../../hooks/useChartTheme';
import { escapeHtml } from '../../util/acrossColors';

echarts.use([BarChart, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);

export interface GroupedRow { id: string; name: string }
export interface GroupedScenario { id: string; code: string; name: string }
export interface GroupedMarkLine { value: number; label: string; color: string }

/**
 * One group of bars per chosen item, one bar per scenario: the exact picture "how does each of my
 * chosen items behave in each scenario". Missing values (equipment switched off in a scenario)
 * simply have no bar.
 */
/** Axis tick without unit and without pointless trailing zeros ('+10,0 pp' -> '+10'). */
const compact = (text: string) => text.replace(/\s*(pp|%|h|p\.u\.|kV)$/, '').replace(/,00?$/, '');

export default function GroupedBars({ rows, scenarios, valueOf, format, unit, markLines = [], min, max, diverging = false, origin = 0 }: {
  rows: GroupedRow[];
  scenarios: GroupedScenario[];
  valueOf: (rowId: string, scenarioId: string) => number | null;
  format: (value: number) => string;
  unit: string;
  markLines?: GroupedMarkLine[];
  min?: number;
  max?: number;
  diverging?: boolean;
  /** Bars start at this value instead of 0 (e.g. nominal voltage 1.000 p.u.), so they show the deviation from it. */
  origin?: number;
}) {
  const theme = useChartTheme();
  const option = useMemo(() => {
    const palette = theme.palette;
    return {
      backgroundColor: 'transparent',
      textStyle: { color: theme.mutedText, fontSize: 11 },
      legend: { top: 0, type: 'scroll', itemWidth: 10, itemHeight: 10, textStyle: { color: theme.text, fontSize: 11 }, data: scenarios.map((s) => s.code) },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        backgroundColor: theme.tooltipBg, borderColor: theme.tooltipBorder, textStyle: { color: theme.text, fontSize: 12 },
        extraCssText: 'max-width: 360px;',
        formatter: (params: { dataIndex: number }[]) => {
          const row = rows[params[0]?.dataIndex ?? 0];
          if (!row) return '';
          const lines = scenarios.map((s, i) => {
            const v = valueOf(row.id, s.id);
            return `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${palette[i % palette.length]}"></span> ${escapeHtml(s.code)} ${escapeHtml(s.name)}: <strong>${v === null ? '–' : escapeHtml(format(v))}</strong>`;
          });
          return `<strong>${escapeHtml(row.name)}</strong><br/>${lines.join('<br/>')}`;
        },
      },
      grid: { left: 8, right: 56, top: 34, bottom: 24, containLabel: true },
      xAxis: {
        type: 'value', min: min === undefined ? undefined : min - origin, max: max === undefined ? undefined : max - origin,
        axisLabel: { color: theme.mutedText, fontSize: 10, formatter: (v: number) => compact(format(v + origin)) },
        name: unit, nameLocation: 'end', nameTextStyle: { color: theme.mutedText },
        splitLine: { lineStyle: { color: theme.grid } }, axisLine: { show: false },
      },
      yAxis: {
        type: 'category', inverse: true, data: rows.map((r) => r.name), axisTick: { show: false },
        axisLine: { lineStyle: { color: theme.axis }, ...(diverging ? { onZero: false } : {}) },
        axisLabel: { color: theme.text, fontSize: 11, width: 150, overflow: 'truncate' },
      },
      series: scenarios.map((s, i) => ({
        type: 'bar', name: s.code, barMaxWidth: 12, barGap: '10%',
        itemStyle: { color: palette[i % palette.length], borderRadius: 2 },
        data: rows.map((r) => { const v = valueOf(r.id, s.id); return v === null ? null : v - origin; }),
        ...(i === 0 && markLines.length > 0 ? {
          markLine: {
            silent: true, symbol: 'none', label: { position: 'insideEndTop', color: theme.mutedText, fontSize: 10 },
            data: markLines.map((m) => ({ xAxis: m.value - origin, label: { formatter: m.label }, lineStyle: { color: m.color, type: 'dashed', width: 1.2 } })),
          },
        } : {}),
      })),
    };
  }, [rows, scenarios, valueOf, format, unit, markLines, min, max, diverging, origin, theme]);

  const height = rows.length * Math.max(scenarios.length * 11 + 14, 30) + 64;
  return <ReactECharts echarts={echarts} option={option} notMerge style={{ height }} />;
}
