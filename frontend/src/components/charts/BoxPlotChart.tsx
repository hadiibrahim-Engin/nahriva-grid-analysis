/**
 * BoxPlotChart - Hourly distribution as box-and-whisker plot.
 *
 * Displays min, Q1, median, Q3, max per hour using ECharts boxplot series.
 * Used for voltage band analysis and general distribution overview.
 */
import ReactECharts from './ReactECharts';
import * as echarts from 'echarts/core';
import { BoxplotChart as EBoxplotChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  ToolboxComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { BoxPlotData } from '../../api/client';
import {
  buildChartExportName,
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

echarts.use([
  EBoxplotChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  ToolboxComponent,
  CanvasRenderer,
]);

interface Props {
  data: BoxPlotData;
}

function boxAxisExtent(items: BoxPlotData['items']) {
  const values = items.flatMap((item) => [item.min, item.max]).filter(Number.isFinite);
  if (values.length === 0) return { min: undefined, max: undefined };

  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min;
  const padding = spread === 0 ? Math.max(Math.abs(min) * 0.02, 1) : spread * 0.16;

  return {
    min: min - padding,
    max: max + padding,
  };
}

export default function BoxPlotChart({ data, ...yScale }: Props & YAxisScaleProps) {
  const theme = useChartTheme();
  const exportName = buildChartExportName({
    base: `Boxplot-${data.measurement_type}`,
    signals: [data.component_name],
  });
  if (data.items.length === 0) {
    return <div className="h-[350px] flex items-center justify-center text-gray-500">Keine Daten</div>;
  }

  const categories = data.items.map((item) => item.label);
  // ECharts boxplot format: [min, Q1, median, Q3, max]
  const boxData = data.items.map((item) => [item.min, item.q1, item.median, item.q3, item.max]);

  // Box fill: a dim companion to the primary border. Mirrors the
  // HeatmapChart light/dark "cool floor" approach.
  const boxFill = theme.isLight ? '#dbeafe' : '#1e3a5f';
  const yExtent = boxAxisExtent(data.items);

  const option = {
    backgroundColor: 'transparent',
    textStyle: { color: theme.mutedText },
    tooltip: {
      trigger: 'item',
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text },
      formatter: (params: { name: string; value: number[] }) => {
        const v = params.value;
        return `<b>${params.name}</b><br/>
          Max: ${formatChartNumber(v[5] ?? v[4])}<br/>
          Q3: ${formatChartNumber(v[4] ?? v[3])}<br/>
          Median: ${formatChartNumber(v[3] ?? v[2])}<br/>
          Q1: ${formatChartNumber(v[2] ?? v[1])}<br/>
          Min: ${formatChartNumber(v[1] ?? v[0])}`;
      },
    },
    toolbox: {
      feature: {
        dataZoom: { yAxisIndex: 'none' },
        restore: {},
        saveAsImage: { name: exportName },
      },
      iconStyle: { borderColor: theme.mutedText },
      right: 20,
    },
    grid: { left: Y_AXIS_GRID_LEFT, right: DATA_ZOOM_Y_GRID_RIGHT, top: 42, bottom: 72, containLabel: true },
    xAxis: {
      type: 'category',
      data: categories,
      axisLabel: { color: theme.mutedText, rotate: 45, fontSize: 10 },
      axisLine: { lineStyle: { color: theme.axis } },
    },
    yAxis: {
      ...scaledValueAxis(yScale, { min: yExtent.min, max: yExtent.max }),
      name: `${data.measurement_type} (${data.unit})`,
      ...yAxisNameStyle(theme.mutedText),
      scale: true,
      axisLabel: { color: theme.mutedText, formatter: formatChartNumber },
      axisLine: { lineStyle: { color: theme.axis } },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    series: [
      {
        name: data.measurement_type,
        type: 'boxplot',
        data: boxData,
        itemStyle: {
          color: boxFill,
          borderColor: theme.primary,
          borderWidth: 1.5,
        },
      },
    ],
    dataZoom: [
      { type: 'inside', start: 0, end: 100, xAxisIndex: 0 },
      { type: 'inside', yAxisIndex: 0, filterMode: 'none' },
      {
        type: 'slider',
        start: 0,
        end: 100,
        height: DATA_ZOOM_SLIDER_HEIGHT,
        bottom: DATA_ZOOM_BOTTOM,
        borderColor: theme.axis,
        backgroundColor: theme.isLight ? '#ffffff' : '#111827',
        dataBackground: { lineStyle: { color: theme.mutedText }, areaStyle: { color: theme.grid } },
        selectedDataBackground: { lineStyle: { color: theme.primary }, areaStyle: { color: theme.primarySoft } },
        textStyle: { color: theme.mutedText },
        handleStyle: { color: theme.mutedText, borderColor: theme.text },
      },
      {
        type: 'slider',
        yAxisIndex: 0,
        width: DATA_ZOOM_SLIDER_WIDTH,
        right: DATA_ZOOM_RIGHT,
        filterMode: 'none',
        borderColor: theme.axis,
        backgroundColor: theme.isLight ? '#ffffff' : '#111827',
        dataBackground: { lineStyle: { color: theme.mutedText }, areaStyle: { color: theme.grid } },
        selectedDataBackground: { lineStyle: { color: theme.primary }, areaStyle: { color: theme.primarySoft } },
        textStyle: { color: theme.mutedText },
        handleStyle: { color: theme.mutedText, borderColor: theme.text },
      },
    ],
  };

  return (
    <ReactECharts
      echarts={echarts}
      option={option}
      style={{ height: 350 }}
      notMerge
      lazyUpdate
    />
  );
}
