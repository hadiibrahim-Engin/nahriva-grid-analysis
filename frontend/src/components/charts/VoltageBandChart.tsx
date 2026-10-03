import ReactECharts from './ReactECharts';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  TooltipComponent,
  LegendComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { VoltageBandData } from '../../api/client';
import {
  DATA_ZOOM_RIGHT,
  DATA_ZOOM_SLIDER_WIDTH,
  DATA_ZOOM_Y_GRID_RIGHT,
  formatChartNumber,
  formatChartValue,
  scaledValueAxis,
  Y_AXIS_GRID_LEFT,
  type YAxisScaleProps,
  yAxisNameStyle,
} from './format';
import { useChartTheme } from '../../hooks/useChartTheme';

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, CanvasRenderer]);

interface Props {
  data: VoltageBandData;
}

export default function VoltageBandChart({ data, ...yScale }: Props & YAxisScaleProps) {
  const theme = useChartTheme();
  // Two-series chart: weekday (primary hue) + weekend (warning hue).
  const wdColor = theme.palette[0];
  const weColor = theme.palette[1];

  const makeTimeSeries = (points: typeof data.weekday) => ({
    times: points.map((p) => {
      const t = new Date(p.timestamp);
      return `${t.getHours().toString().padStart(2, '0')}:${t.getMinutes().toString().padStart(2, '0')}`;
    }),
    min: points.map((p) => p.min),
    mean: points.map((p) => p.mean),
    max: points.map((p) => p.max),
  });

  const wd = makeTimeSeries(data.weekday);
  const we = makeTimeSeries(data.weekend);
  const times = wd.times.length > we.times.length ? wd.times : we.times;

  const option = {
    backgroundColor: 'transparent',
    textStyle: { color: theme.mutedText },
    tooltip: {
      trigger: 'axis',
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text },
      valueFormatter: formatChartValue,
    },
    legend: {
      data: ['Wochentag Min', 'Wochentag Mittel', 'Wochentag Max', 'Wochenende Min', 'Wochenende Mittel', 'Wochenende Max'],
      textStyle: { color: theme.mutedText, fontSize: 10 },
      top: 0,
      type: 'scroll',
    },
    grid: { left: Y_AXIS_GRID_LEFT, right: DATA_ZOOM_Y_GRID_RIGHT, top: 50, bottom: 30, containLabel: true },
    xAxis: {
      type: 'category',
      data: times,
      axisLabel: { color: theme.mutedText, rotate: 45, fontSize: 10 },
      axisLine: { lineStyle: { color: theme.axis } },
    },
    yAxis: {
      ...scaledValueAxis(yScale),
      name: data.unit,
      ...yAxisNameStyle(theme.mutedText),
      axisLabel: { color: theme.mutedText, formatter: formatChartNumber },
      axisLine: { lineStyle: { color: theme.axis } },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    series: [
      // Weekday band
      { name: 'Wochentag Min', type: 'line', data: wd.min, lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, stack: 'wd', showSymbol: false, color: wdColor },
      { name: 'Wochentag Max', type: 'line', data: wd.max.map((v, i) => v - wd.min[i]), lineStyle: { opacity: 0 }, areaStyle: { opacity: 0.2, color: wdColor }, stack: 'wd', showSymbol: false, color: wdColor },
      { name: 'Wochentag Mittel', type: 'line', data: wd.mean, lineStyle: { width: 2, color: wdColor }, showSymbol: false, color: wdColor },
      // Weekend band
      { name: 'Wochenende Min', type: 'line', data: we.min, lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, stack: 'we', showSymbol: false, color: weColor },
      { name: 'Wochenende Max', type: 'line', data: we.max.map((v, i) => v - (we.min[i] || 0)), lineStyle: { opacity: 0 }, areaStyle: { opacity: 0.2, color: weColor }, stack: 'we', showSymbol: false, color: weColor },
      { name: 'Wochenende Mittel', type: 'line', data: we.mean, lineStyle: { width: 2, color: weColor }, showSymbol: false, color: weColor },
    ],
    dataZoom: [
      { type: 'inside' as const, yAxisIndex: 0, filterMode: 'none' as const },
      {
        type: 'slider' as const,
        yAxisIndex: 0,
        width: DATA_ZOOM_SLIDER_WIDTH,
        right: DATA_ZOOM_RIGHT,
        filterMode: 'none' as const,
        borderColor: theme.axis,
        backgroundColor: theme.isLight ? '#ffffff' : '#111827',
        textStyle: { color: theme.mutedText },
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
