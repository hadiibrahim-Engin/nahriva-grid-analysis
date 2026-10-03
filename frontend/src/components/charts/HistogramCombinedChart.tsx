/**
 * HistogramCombinedChart — overlays the value distributions of several signals
 * in one chart, using a shared bin range so the bars line up. Complements the
 * single-signal `TimeseriesHistogramChart` (switched via a dropdown); this is
 * the "combined" view where all selected quantities appear together.
 *
 * Bars are grouped side-by-side per bin (not stacked) so each signal's shape
 * stays readable. A legend lets the user toggle individual signals.
 */
import { useMemo } from 'react';
import ReactECharts from './ReactECharts';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
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
  formatChartValue,
  scaledValueAxis,
  Y_AXIS_GRID_LEFT,
  type YAxisScaleProps,
  yAxisNameStyle,
} from './format';
import { useChartTheme } from '../../hooks/useChartTheme';

echarts.use([BarChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, CanvasRenderer]);

interface Props {
  seriesList: { label: string; data: TimeseriesData }[];
  binCount: number;
}

export default function HistogramCombinedChart({
  seriesList,
  binCount,
  yAxisScaleType,
  yAxisMin,
  yAxisMax,
  yAxisLog,
}: Props & YAxisScaleProps) {
  const theme = useChartTheme();
  const option = useMemo(() => {
    // A single shared bin range across every signal so bars align per bin.
    const allValues = seriesList.flatMap(({ data }) =>
      data.data.map((p) => p.value).filter((v) => Number.isFinite(v)),
    );
    if (allValues.length === 0) return null;

    const rawMin = Math.min(...allValues);
    const rawMax = Math.max(...allValues);
    const spread = rawMax - rawMin;
    const min = spread === 0 ? rawMin - 0.5 : rawMin;
    const max = spread === 0 ? rawMax + 0.5 : rawMax;
    const step = (max - min) / binCount;

    const labels = Array.from({ length: binCount }, (_, index) => {
      const start = min + index * step;
      return `${formatChartNumber(start)}-${formatChartNumber(start + step)}`;
    });

    const barSeries = seriesList.map(({ label, data }, i) => {
      const counts = Array.from({ length: binCount }, () => 0);
      for (const point of data.data) {
        if (!Number.isFinite(point.value)) continue;
        const index = Math.min(binCount - 1, Math.max(0, Math.floor((point.value - min) / step)));
        counts[index] += 1;
      }
      return {
        name: label,
        type: 'bar' as const,
        data: counts,
        barMaxWidth: 40,
        itemStyle: { color: theme.palette[i % theme.palette.length], borderRadius: [3, 3, 0, 0] as [number, number, number, number] },
      };
    });

    return {
      backgroundColor: 'transparent',
      textStyle: { color: theme.mutedText },
      tooltip: {
        trigger: 'axis' as const,
        backgroundColor: theme.tooltipBg,
        borderColor: theme.tooltipBorder,
        textStyle: { color: theme.text },
        axisPointer: { type: 'shadow' as const },
        valueFormatter: (value: unknown) => formatChartValue(value),
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
        data: labels,
        axisLabel: { color: theme.mutedText, rotate: 45, fontSize: 10 },
        axisLine: { lineStyle: { color: theme.axis } },
      },
      yAxis: {
        ...scaledValueAxis({ yAxisScaleType, yAxisMin, yAxisMax, yAxisLog }),
        name: 'Count',
        ...yAxisNameStyle(theme.mutedText),
        axisLabel: { color: theme.mutedText, formatter: formatChartNumber },
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
      series: barSeries,
    };
  }, [seriesList, binCount, theme, yAxisScaleType, yAxisMin, yAxisMax, yAxisLog]);

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
