import ReactECharts from './ReactECharts';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { DurationCurveData, DurationCurvePoint } from '../../api/client';
import {
  DATA_ZOOM_RIGHT,
  DATA_ZOOM_SLIDER_WIDTH,
  DATA_ZOOM_Y_GRID_RIGHT,
  formatChartNumber,
  formatChartPercent,
  scaledValueAxis,
  Y_AXIS_GRID_LEFT,
  type YAxisScaleProps,
  yAxisNameStyle,
} from './format';
import { useChartTheme } from '../../hooks/useChartTheme';

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, CanvasRenderer]);

interface Props {
  data: DurationCurveData;
  /**
   * Optional multiple curves to overlay in one chart (comparison of several
   * signals). When given, the area fill is dropped and a legend is shown.
   */
  series?: { label: string; unit?: string; data: DurationCurvePoint[] }[];
}

// Distinct hues for overlaid duration curves.
const MULTI_PALETTE = ['#2f80ff', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#ec4899'];

export default function DurationCurveChart({ data, series, ...yScale }: Props & YAxisScaleProps) {
  const theme = useChartTheme();
  const multi = series && series.length > 1;
  // When overlaid curves carry different units (e.g. MW vs kV), one shared
  // y-axis cannot label them all — fall back to a generic axis name.
  const units = multi ? Array.from(new Set(series!.map((s) => s.unit).filter(Boolean))) : [];
  const mixedUnits = units.length > 1;
  const yAxisName = multi ? (mixedUnits ? 'Wert' : `${data.measurement_type} (${units[0] ?? data.unit})`) : `${data.measurement_type} (${data.unit})`;
  // Use the theme's "success" hue as the curve colour — visually
  // distinct from the primary palette and meaningful: this is a
  // utilisation-style curve.
  const curveColor = theme.success;
  // Hex → rgba helper for gradient stops.
  const toRgba = (hex: string, alpha: number) => {
    const m = hex.replace('#', '');
    const r = parseInt(m.slice(0, 2), 16);
    const g = parseInt(m.slice(2, 4), 16);
    const b = parseInt(m.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  const option = {
    backgroundColor: 'transparent',
    textStyle: { color: theme.mutedText },
    tooltip: {
      trigger: 'axis',
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text },
      formatter: (params: { value: number[]; seriesName?: string; marker?: string }[]) => {
        const pct = formatChartPercent(params[0].value[0]);
        if (multi) {
          const unitByName = new Map(series!.map((s) => [s.label, s.unit ?? data.unit]));
          const lines = params
            .map((p) => `${p.marker ?? ''} ${p.seriesName}: ≥ ${formatChartNumber(p.value[1])} ${unitByName.get(p.seriesName ?? '') ?? ''}`)
            .join('<br/>');
          return `${pct} of the time<br/>${lines}`;
        }
        return `${pct} of the time<br/>≥ ${formatChartNumber(params[0].value[1])} ${data.unit}`;
      },
    },
    legend: multi
      ? { top: 6, textStyle: { color: theme.mutedText }, type: 'scroll' }
      : undefined,
    grid: { left: Y_AXIS_GRID_LEFT, right: DATA_ZOOM_Y_GRID_RIGHT, top: multi ? 56 : 42, bottom: 54, containLabel: true },
    xAxis: {
      type: 'value',
      name: 'Exceedance duration (%)',
      nameLocation: 'center',
      nameGap: 25,
      nameTextStyle: { color: theme.mutedText },
      axisLabel: { color: theme.mutedText, formatter: formatChartNumber },
      axisLine: { lineStyle: { color: theme.axis } },
      splitLine: { lineStyle: { color: theme.grid } },
      max: 100,
    },
    yAxis: {
      ...scaledValueAxis(yScale),
      name: yAxisName,
      ...yAxisNameStyle(theme.mutedText),
      axisLabel: { color: theme.mutedText, formatter: formatChartNumber },
      axisLine: { lineStyle: { color: theme.axis } },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    series: multi
      ? series!.map((s, i) => ({
          type: 'line',
          name: s.label,
          showSymbol: false,
          lineStyle: { width: 2, color: MULTI_PALETTE[i % MULTI_PALETTE.length] },
          itemStyle: { color: MULTI_PALETTE[i % MULTI_PALETTE.length] },
          data: s.data.map((p) => [p.percent, p.value]),
        }))
      : [
          {
            type: 'line',
            showSymbol: false,
            lineStyle: { width: 2, color: curveColor },
            areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: toRgba(curveColor, 0.3) },
              { offset: 1, color: toRgba(curveColor, 0.02) },
            ])},
            data: data.data.map((p) => [p.percent, p.value]),
          },
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
