import { useMemo } from 'react';
import ReactECharts from './ReactECharts';
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { PowerFactorData } from '../../api/client';
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

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, MarkLineComponent, CanvasRenderer]);

interface Props {
  data: PowerFactorData;
  series?: { label: string; data: PowerFactorData }[];
  mode: 'timeseries' | 'histogram';
}

export default function PowerFactorChart({
  data,
  series: seriesInput,
  mode,
  yAxisScaleType,
  yAxisMin,
  yAxisMax,
  yAxisLog,
}: Props & YAxisScaleProps) {
  const theme = useChartTheme();
  const option = useMemo(() => {
    if (mode === 'histogram') {
      const bins = data.histogram_bins;
      const labels = bins.slice(0, -1).map((b, i) => `${formatChartNumber(b)}-${formatChartNumber(bins[i + 1])}`);
      return {
        backgroundColor: 'transparent',
        textStyle: { color: theme.mutedText },
        tooltip: { trigger: 'axis' as const, backgroundColor: theme.tooltipBg, borderColor: theme.tooltipBorder, textStyle: { color: theme.text }, valueFormatter: formatChartValue },
        grid: { left: Y_AXIS_GRID_LEFT, right: DATA_ZOOM_Y_GRID_RIGHT, top: 30, bottom: 60, containLabel: true },
        xAxis: {
          type: 'category' as const,
          data: labels,
          axisLabel: { color: theme.mutedText, rotate: 45, fontSize: 10 },
          axisLine: { lineStyle: { color: theme.axis } },
        },
        yAxis: {
          ...scaledValueAxis({ yAxisScaleType, yAxisMin, yAxisMax, yAxisLog }),
          name: 'Häufigkeit',
          ...yAxisNameStyle(theme.mutedText),
          axisLabel: { color: theme.mutedText, formatter: formatChartNumber },
          axisLine: { lineStyle: { color: theme.axis } },
          splitLine: { lineStyle: { color: theme.grid } },
        },
        series: [{
          type: 'bar' as const,
          data: data.histogram_counts,
          itemStyle: {
            color: (params: { dataIndex: number }) => {
              const midVal = (bins[params.dataIndex] + bins[params.dataIndex + 1]) / 2;
              if (midVal >= 0.9) return theme.success;
              if (midVal >= 0.7) return theme.warning;
              return theme.danger;
            },
          },
          markLine: {
            data: [{ xAxis: 18, label: { formatter: 'cos φ = 0.9', color: theme.mutedText }, lineStyle: { color: theme.success, type: 'dashed' as const } }],
            silent: true,
          },
        }],
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
            handleStyle: { color: theme.mutedText, borderColor: theme.mutedText },
          },
        ],
      };
    }

    // Timeseries mode
    const powerFactorSeries = seriesInput?.length
      ? seriesInput
      : [{ label: data.component_name, data }];
    const chartSeries = powerFactorSeries.flatMap(({ label, data: item }, index) => {
      const color = theme.palette[index % theme.palette.length];
      const prefix = powerFactorSeries.length > 1 ? `${label} · ` : '';
      return [
        {
          name: `${prefix}cos φ`,
          type: 'line' as const,
          showSymbol: false,
          lineStyle: { width: 1.5, type: 'solid' as const },
          data: item.data.filter((p) => p.cos_phi !== null).map((p) => [p.timestamp, p.cos_phi]),
          color,
          sampling: 'lttb' as const,
        },
        {
          name: `${prefix}tan φ`,
          type: 'line' as const,
          showSymbol: false,
          lineStyle: { width: 1.5, type: 'dashed' as const },
          data: item.data.filter((p) => p.tan_phi !== null).map((p) => [p.timestamp, p.tan_phi]),
          color,
          sampling: 'lttb' as const,
        },
      ];
    });
    return {
      backgroundColor: 'transparent',
      textStyle: { color: theme.mutedText },
      tooltip: { trigger: 'axis' as const, backgroundColor: theme.tooltipBg, borderColor: theme.tooltipBorder, textStyle: { color: theme.text }, valueFormatter: formatChartValue },
      legend: {
        data: chartSeries.map((s) => s.name),
        textStyle: { color: theme.mutedText },
        top: 0,
        type: 'scroll' as const,
      },
      grid: { left: Y_AXIS_GRID_LEFT, right: DATA_ZOOM_Y_GRID_RIGHT, top: 40, bottom: 72, containLabel: true },
      xAxis: {
        type: 'time' as const,
        axisLine: { lineStyle: { color: theme.axis } },
        axisLabel: { color: theme.mutedText, formatter: formatChartNumber },
        splitLine: { lineStyle: { color: theme.grid } },
      },
      yAxis: {
        ...scaledValueAxis({ yAxisScaleType, yAxisMin, yAxisMax, yAxisLog }),
        name: 'Faktor',
        ...yAxisNameStyle(theme.mutedText),
        scale: true,
        axisLine: { lineStyle: { color: theme.axis } },
        axisLabel: { color: theme.mutedText, formatter: formatChartNumber },
        splitLine: { lineStyle: { color: theme.grid } },
      },
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
          textStyle: { color: theme.mutedText },
        },
        {
          type: 'slider',
          yAxisIndex: 0,
          width: DATA_ZOOM_SLIDER_WIDTH,
          right: DATA_ZOOM_RIGHT,
          filterMode: 'none',
          borderColor: theme.axis,
          backgroundColor: theme.isLight ? '#ffffff' : '#111827',
          textStyle: { color: theme.mutedText },
          handleStyle: { color: theme.mutedText, borderColor: theme.mutedText },
        },
      ],
      series: chartSeries,
    };
  }, [data, seriesInput, mode, theme, yAxisScaleType, yAxisMin, yAxisMax, yAxisLog]);

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
