import { useMemo } from 'react';
import ReactECharts from './ReactECharts';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { TimeseriesData } from '../../api/client';
import {
  DATA_ZOOM_BOTTOM,
  DATA_ZOOM_RIGHT,
  DATA_ZOOM_SLIDER_HEIGHT,
  DATA_ZOOM_SLIDER_WIDTH,
  DATA_ZOOM_Y_GRID_RIGHT,
  formatChartNumber,
  formatChartPercent,
  formatChartValue,
  scaledValueAxis,
  Y_AXIS_GRID_LEFT,
  type YAxisScaleProps,
  yAxisNameStyle,
} from './format';
import { useChartTheme } from '../../hooks/useChartTheme';

echarts.use([BarChart, GridComponent, TooltipComponent, DataZoomComponent, CanvasRenderer]);

interface Props {
  series: TimeseriesData;
  binCount: number;
  mode: 'count' | 'percent';
  cumulative: boolean;
}

function formatValue(value: number): string {
  return formatChartNumber(value);
}

export default function TimeseriesHistogramChart({
  series,
  binCount,
  mode,
  cumulative,
  yAxisScaleType,
  yAxisMin,
  yAxisMax,
  yAxisLog,
}: Props & YAxisScaleProps) {
  const theme = useChartTheme();
  const option = useMemo(() => {
    const values = series.data
      .map((point) => point.value)
      .filter((value) => Number.isFinite(value));

    if (values.length === 0) return null;

    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const spread = rawMax - rawMin;
    const min = spread === 0 ? rawMin - 0.5 : rawMin;
    const max = spread === 0 ? rawMax + 0.5 : rawMax;
    const step = (max - min) / binCount;
    const counts = Array.from({ length: binCount }, () => 0);

    for (const value of values) {
      const index = Math.min(binCount - 1, Math.max(0, Math.floor((value - min) / step)));
      counts[index] += 1;
    }

    const labels = counts.map((_, index) => {
      const start = min + index * step;
      const end = start + step;
      return `${formatValue(start)}-${formatValue(end)}`;
    });
    const displayValues = counts.map((count, index) => {
      const raw = cumulative
        ? counts.slice(0, index + 1).reduce((sum, value) => sum + value, 0)
        : count;
      return mode === 'percent' ? Math.round((raw / values.length) * 1000) / 10 : raw;
    });
    const axisName = mode === 'percent' ? (cumulative ? 'Cumulative (%)' : 'Share (%)') : (cumulative ? 'Cumulative' : 'Count');

    return {
      backgroundColor: 'transparent',
      textStyle: { color: theme.mutedText },
      tooltip: {
        trigger: 'axis' as const,
        backgroundColor: theme.tooltipBg,
        borderColor: theme.tooltipBorder,
        textStyle: { color: theme.text },
        axisPointer: { type: 'shadow' as const },
        valueFormatter: (value: unknown) => (
          mode === 'percent' ? formatChartPercent(Number(value)) : formatChartValue(value)
        ),
      },
      grid: { left: Y_AXIS_GRID_LEFT, right: DATA_ZOOM_Y_GRID_RIGHT, top: 24, bottom: 84, containLabel: true },
      xAxis: {
        type: 'category' as const,
        data: labels,
        name: series.unit,
        nameTextStyle: { color: theme.mutedText },
        axisLabel: { color: theme.mutedText, rotate: 45, fontSize: 10 },
        axisLine: { lineStyle: { color: theme.axis } },
      },
      yAxis: {
        ...scaledValueAxis({ yAxisScaleType, yAxisMin, yAxisMax, yAxisLog }),
        name: axisName,
        ...yAxisNameStyle(theme.mutedText),
        axisLabel: {
          color: theme.mutedText,
          formatter: (value: number) => mode === 'percent' ? formatChartPercent(value) : formatChartNumber(value),
        },
        axisLine: { lineStyle: { color: theme.axis } },
        splitLine: { lineStyle: { color: theme.grid } },
      },
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
      series: [
        {
          name: `${series.measurement_type} (${series.unit})`,
          type: 'bar' as const,
          data: displayValues,
          barMaxWidth: 54,
          itemStyle: { color: theme.primary, borderRadius: [3, 3, 0, 0] },
        },
      ],
    };
  }, [series, binCount, mode, cumulative, theme, yAxisScaleType, yAxisMin, yAxisMax, yAxisLog]);

  if (!option) {
    return (
      <div className="h-[260px] flex items-center justify-center text-gray-500">
        No histogram data
      </div>
    );
  }

  return (
    <ReactECharts
      echarts={echarts}
      option={option}
      style={{ width: '100%', height: 340 }}
      notMerge
      lazyUpdate
    />
  );
}
