/**
 * BoxPlotCombinedChart — overlays several signals' boxplots in one chart,
 * one boxplot series per signal, grouped side-by-side per category (hour /
 * weekday / month / weekday-weekend — whatever the shared `group_by` is).
 * Complements the single-signal `BoxPlotChart` (switched via a dropdown);
 * this is the "combined" view where all selected quantities appear together.
 */
import ReactECharts from './ReactECharts';
import * as echarts from 'echarts/core';
import { BoxplotChart as EBoxplotChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { BoxPlotData } from '../../api/client';
import {
  DATA_ZOOM_BOTTOM,
  DATA_ZOOM_RIGHT,
  DATA_ZOOM_SLIDER_HEIGHT,
  DATA_ZOOM_SLIDER_WIDTH,
  DATA_ZOOM_Y_GRID_RIGHT,
  formatChartNumber,
  scaledValueAxis,
  Y_AXIS_GRID_LEFT,
  type YAxisScaleProps,
  yAxisNameStyle,
} from './format';
import { useChartTheme } from '../../hooks/useChartTheme';

echarts.use([EBoxplotChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, CanvasRenderer]);

interface Props {
  seriesList: { label: string; data: BoxPlotData }[];
}

function boxAxisExtent(seriesList: { data: BoxPlotData }[]) {
  const values = seriesList.flatMap(({ data }) => data.items.flatMap((item) => [item.min, item.max]))
    .filter(Number.isFinite);
  if (values.length === 0) return { min: undefined, max: undefined };

  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min;
  const padding = spread === 0 ? Math.max(Math.abs(min) * 0.02, 1) : spread * 0.16;
  return { min: min - padding, max: max + padding };
}

export default function BoxPlotCombinedChart({ seriesList, ...yScale }: Props & YAxisScaleProps) {
  const theme = useChartTheme();

  if (seriesList.every(({ data }) => data.items.length === 0)) {
    return <div className="h-[350px] flex items-center justify-center text-gray-500">No data</div>;
  }

  // Category order: take it from whichever series has the most buckets (the
  // most complete picture) — all series share the same group_by, so their
  // label order already matches; this just covers sparser signals gracefully.
  const canonical = seriesList.reduce((best, cur) => (
    cur.data.items.length > best.data.items.length ? cur : best
  ), seriesList[0]);
  const categories = canonical.data.items.map((item) => item.label);

  const boxSeries = seriesList.map(({ label, data }, i) => {
    const byLabel = new Map(data.items.map((item) => [item.label, item]));
    const color = theme.palette[i % theme.palette.length];
    return {
      name: label,
      type: 'boxplot' as const,
      data: categories.map((cat) => {
        const item = byLabel.get(cat);
        return item ? [item.min, item.q1, item.median, item.q3, item.max] : null;
      }),
      itemStyle: { color, borderColor: color, borderWidth: 1.5 },
    };
  });

  const yExtent = boxAxisExtent(seriesList);
  const distinctUnits = [...new Set(seriesList.map(({ data }) => data.unit))];
  const yAxisName = distinctUnits.length === 1 ? distinctUnits[0] : 'Wert';

  const option = {
    backgroundColor: 'transparent',
    textStyle: { color: theme.mutedText },
    tooltip: {
      trigger: 'item' as const,
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text },
      formatter: (params: { seriesName: string; name: string; value: (number | null)[] }) => {
        const v = params.value;
        if (!v || v[1] == null) return `<b>${params.seriesName} · ${params.name}</b><br/>No data`;
        return `<b>${params.seriesName} · ${params.name}</b><br/>
          Max: ${formatChartNumber(v[5] ?? v[4])}<br/>
          Q3: ${formatChartNumber(v[4] ?? v[3])}<br/>
          Median: ${formatChartNumber(v[3] ?? v[2])}<br/>
          Q1: ${formatChartNumber(v[2] ?? v[1])}<br/>
          Min: ${formatChartNumber(v[1] ?? v[0])}`;
      },
    },
    legend: {
      data: seriesList.map((s) => s.label),
      textStyle: { color: theme.mutedText, fontSize: 11 },
      top: 0,
      type: 'scroll' as const,
    },
    grid: { left: Y_AXIS_GRID_LEFT, right: DATA_ZOOM_Y_GRID_RIGHT, top: 34, bottom: 84, containLabel: true },
    xAxis: {
      type: 'category' as const,
      data: categories,
      axisLabel: { color: theme.mutedText, rotate: 45, fontSize: 10 },
      axisLine: { lineStyle: { color: theme.axis } },
    },
    yAxis: {
      ...scaledValueAxis(yScale, { min: yExtent.min, max: yExtent.max }),
      name: yAxisName,
      ...yAxisNameStyle(theme.mutedText),
      scale: true,
      axisLabel: { color: theme.mutedText, formatter: formatChartNumber },
      axisLine: { lineStyle: { color: theme.axis } },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    series: boxSeries,
    dataZoom: [
      { type: 'inside' as const, start: 0, end: 100, xAxisIndex: 0 },
      { type: 'inside' as const, yAxisIndex: 0, filterMode: 'none' as const },
      {
        type: 'slider' as const,
        start: 0,
        end: 100,
        height: DATA_ZOOM_SLIDER_HEIGHT,
        bottom: DATA_ZOOM_BOTTOM,
        borderColor: theme.axis,
        backgroundColor: theme.isLight ? '#ffffff' : '#111827',
        textStyle: { color: theme.mutedText },
        handleStyle: { color: theme.mutedText, borderColor: theme.mutedText },
      },
      {
        type: 'slider' as const,
        yAxisIndex: 0,
        width: DATA_ZOOM_SLIDER_WIDTH,
        right: DATA_ZOOM_RIGHT,
        filterMode: 'none' as const,
        borderColor: theme.axis,
        backgroundColor: theme.isLight ? '#ffffff' : '#111827',
        textStyle: { color: theme.mutedText },
        handleStyle: { color: theme.mutedText, borderColor: theme.mutedText },
      },
    ],
  };

  return (
    <ReactECharts
      echarts={echarts}
      option={option}
      style={{ height: 380 }}
      notMerge
      lazyUpdate
    />
  );
}
