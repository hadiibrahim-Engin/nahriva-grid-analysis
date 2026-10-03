import ReactECharts from './ReactECharts';
import * as echarts from 'echarts/core';
import { ScatterChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, DataZoomComponent, VisualMapComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { CorrelationScatterData } from '../../api/client';
import { CORRELATION_METHOD_LABELS, CORRELATION_METHOD_SYMBOLS, type CorrelationScatterData3 } from '../../util/dynamicCharts';
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

echarts.use([ScatterChart, GridComponent, TooltipComponent, DataZoomComponent, VisualMapComponent, CanvasRenderer]);

const MTYPE_LABELS: Record<string, string> = {
  P: 'Active power', Q: 'Reactive power', S: 'Apparent power',
  U: 'Voltage', I: 'Current', loading: 'Loading',
};

type CorrelationDataWithLabels = (CorrelationScatterData | CorrelationScatterData3) & {
  label_x?: string;
  label_y?: string;
  label_z?: string;
};

interface Props {
  data: CorrelationDataWithLabels;
}

function hasZ(data: CorrelationDataWithLabels): data is CorrelationScatterData3 & { label_x?: string; label_y?: string; label_z?: string } {
  return 'type_z' in data;
}

export default function CorrelationChart({ data, ...yScale }: Props & YAxisScaleProps) {
  const theme = useChartTheme();
  const labelX = data.label_x ?? MTYPE_LABELS[data.type_x] ?? data.type_x;
  const labelY = data.label_y ?? MTYPE_LABELS[data.type_y] ?? data.type_y;
  const withZ = hasZ(data);
  const labelZ = withZ ? (data.label_z ?? MTYPE_LABELS[data.type_z] ?? data.type_z) : null;
  const zValues = withZ ? data.data.map((p) => p.z) : [];

  const direction = Math.abs(data.correlation) > 0.7
    ? 'Strong'
    : Math.abs(data.correlation) > 0.4
      ? 'Moderate'
      : 'Weak';
  const method = data.method ?? 'pearson';
  const methodSymbol = CORRELATION_METHOD_SYMBOLS[method];

  const option = {
    backgroundColor: 'transparent',
    textStyle: { color: theme.mutedText },
    tooltip: {
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text },
      formatter: (params: { value: number[] }) => {
        const base = `${labelX}: ${formatChartNumber(params.value[0])} ${data.unit_x}<br/>${labelY}: ${formatChartNumber(params.value[1])} ${data.unit_y}`;
        return withZ
          ? `${base}<br/>${labelZ}: ${formatChartNumber(params.value[2])} ${data.unit_z}`
          : base;
      },
    },
    ...(withZ
      ? {
          visualMap: {
            type: 'continuous' as const,
            dimension: 2,
            min: Math.min(...zValues),
            max: Math.max(...zValues),
            calculable: true,
            orient: 'horizontal' as const,
            left: 'center' as const,
            top: 0,
            text: [`${labelZ} (${data.unit_z}) high`, 'low'],
            textStyle: { color: theme.mutedText },
            inRange: { color: [theme.primary, theme.warning] },
          },
        }
      : {}),
    grid: { left: Y_AXIS_GRID_LEFT, right: DATA_ZOOM_Y_GRID_RIGHT, top: withZ ? 68 : 36, bottom: 74, containLabel: true },
    xAxis: {
      type: 'value',
      // A scatter's X range should fit the actual data, not always include
      // zero — ECharts' default for value axes forces zero into the range
      // otherwise, which is wrong here (e.g. values clustered at 200-250
      // would still show the axis starting at 0).
      scale: true,
      name: `${labelX} (${data.unit_x})`,
      nameLocation: 'center',
      nameGap: 30,
      nameTextStyle: { color: theme.mutedText },
      axisLabel: { color: theme.mutedText, formatter: formatChartNumber },
      axisLine: { lineStyle: { color: theme.axis } },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    yAxis: {
      ...scaledValueAxis(yScale, undefined, { scaleToData: true }),
      name: `${labelY} (${data.unit_y})`,
      ...yAxisNameStyle(theme.mutedText, 68),
      axisLabel: { color: theme.mutedText, formatter: formatChartNumber },
      axisLine: { lineStyle: { color: theme.axis } },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    dataZoom: [
      // Independent mouse-wheel/pinch zoom per axis. A single dataZoom entry
      // listing both xAxisIndex and yAxisIndex links them into one zoom unit
      // (scaling X also scales Y) — two separate entries keep them independent,
      // matching the two slider dataZoom components below.
      { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
      { type: 'inside', yAxisIndex: 0, filterMode: 'none' },
      {
        type: 'slider',
        xAxisIndex: 0,
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
        right: DATA_ZOOM_RIGHT,
        width: DATA_ZOOM_SLIDER_WIDTH,
        filterMode: 'none',
        borderColor: theme.axis,
        backgroundColor: theme.isLight ? '#ffffff' : '#111827',
        dataBackground: { lineStyle: { color: theme.mutedText }, areaStyle: { color: theme.grid } },
        selectedDataBackground: { lineStyle: { color: theme.primary }, areaStyle: { color: theme.primarySoft } },
        textStyle: { color: theme.mutedText },
        handleStyle: { color: theme.mutedText, borderColor: theme.text },
      },
    ],
    series: [
      {
        type: 'scatter',
        data: withZ
          ? data.data.map((p) => [p.x, p.y, (p as { z: number }).z])
          : data.data.map((p) => [p.x, p.y]),
        symbolSize: 4,
        itemStyle: withZ ? { opacity: 0.75 } : { color: theme.primary, opacity: 0.6 },
      },
    ],
  };

  return (
    <div className="relative">
      <div
        className="absolute right-3 top-2 z-10 rounded bg-black/30 px-2 py-1 text-xs"
        style={{ color: theme.mutedText }}
      >
        <span className="font-semibold" style={{ color: theme.text }}>{methodSymbol} = {data.correlation.toFixed(2)}</span>
        <span className="ml-1">({direction.toLowerCase()} correlation, {CORRELATION_METHOD_LABELS[method]})</span>
      </div>
      <ReactECharts
        echarts={echarts}
        option={option}
        style={{ height: 400 }}
        notMerge
        lazyUpdate
      />
    </div>
  );
}
