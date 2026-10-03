/**
 * DailyProfileChart - Typical daily load profile with standard deviation bands.
 *
 * Shows weekday vs weekend average curves. When std_dev data is available,
 * renders a shaded +/- 1 sigma band around each curve.
 */
import ReactECharts from './ReactECharts';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, DataZoomComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { DailyProfileData } from '../../api/client';
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

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, CanvasRenderer]);

interface Props {
  data: DailyProfileData;
  series?: { label: string; data: DailyProfileData }[];
  showStdDev?: boolean;
}

export default function DailyProfileChart({ data, series: seriesInput, showStdDev = true, ...yScale }: Props & YAxisScaleProps) {
  const theme = useChartTheme();
  const profileSeries = seriesInput?.length
    ? seriesInput
    : [{ label: data.component_name, data }];
  const formatHour = (h: number) => {
    const hours = Math.floor(h);
    const mins = Math.round((h - hours) * 60);
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
  };

  const allHours = [...new Set([
    ...profileSeries.flatMap(({ data: item }) => item.weekday_avg.map(p => p.hour)),
    ...profileSeries.flatMap(({ data: item }) => item.weekend_avg.map(p => p.hour)),
  ])].sort((a, b) => a - b);

  const hasStdDev = showStdDev
    && profileSeries.length === 1
    && profileSeries[0].data.weekday_avg.some(p => p.std_dev !== null && p.std_dev !== undefined);

  const series: object[] = [];

  if (hasStdDev) {
    const wdColor = theme.palette[0];
    const weColor = theme.palette[1];
    const only = profileSeries[0].data;
    const wdMap = new Map(only.weekday_avg.map(p => [p.hour, p]));
    const weMap = new Map(only.weekend_avg.map(p => [p.hour, p]));
    // Weekday lower bound (invisible, used as stack base for the band)
    series.push({
      name: '_wd_lower',
      type: 'line',
      data: allHours.map(h => {
        const p = wdMap.get(h);
        return p && p.std_dev != null ? Math.max(0, p.value - p.std_dev) : null;
      }),
      lineStyle: { opacity: 0 },
      areaStyle: { opacity: 0 },
      stack: 'wd_band',
      showSymbol: false,
      silent: true,
    });
    // Weekday band width (lower->upper)
    series.push({
      name: 'Wochentag \u00b1\u03c3',
      type: 'line',
      data: allHours.map(h => {
        const p = wdMap.get(h);
        return p && p.std_dev != null ? 2 * p.std_dev : null;
      }),
      lineStyle: { opacity: 0 },
      areaStyle: { opacity: 0.15, color: wdColor },
      stack: 'wd_band',
      showSymbol: false,
      silent: true,
    });
    // Weekend lower bound
    series.push({
      name: '_we_lower',
      type: 'line',
      data: allHours.map(h => {
        const p = weMap.get(h);
        return p && p.std_dev != null ? Math.max(0, p.value - p.std_dev) : null;
      }),
      lineStyle: { opacity: 0 },
      areaStyle: { opacity: 0 },
      stack: 'we_band',
      showSymbol: false,
      silent: true,
    });
    // Weekend band width
    series.push({
      name: 'Wochenende \u00b1\u03c3',
      type: 'line',
      data: allHours.map(h => {
        const p = weMap.get(h);
        return p && p.std_dev != null ? 2 * p.std_dev : null;
      }),
      lineStyle: { opacity: 0 },
      areaStyle: { opacity: 0.15, color: weColor },
      stack: 'we_band',
      showSymbol: false,
      silent: true,
    });
  }

  // Main curves (always on top). Multi-profile mode keeps weekday/weekend as
  // solid/dashed pairs with the same color per selected source.
  profileSeries.forEach(({ label, data: item }, index) => {
    const color = theme.palette[index % theme.palette.length];
    const wdMap = new Map(item.weekday_avg.map(p => [p.hour, p]));
    const weMap = new Map(item.weekend_avg.map(p => [p.hour, p]));
    const prefix = profileSeries.length > 1 ? `${label} · ` : '';
    series.push({
      name: `${prefix}Wochentag (Mo-Fr)`,
      type: 'line',
      showSymbol: false,
      lineStyle: { width: 2, type: 'solid' },
      color,
      data: allHours.map(h => wdMap.get(h)?.value ?? null),
      z: 10,
    });
    series.push({
      name: `${prefix}Wochenende (Sa-So)`,
      type: 'line',
      showSymbol: false,
      lineStyle: { width: 2, type: 'dashed' },
      color,
      data: allHours.map(h => weMap.get(h)?.value ?? null),
      z: 10,
    });
  });

  const legendData = series
    .map((s) => (s as { name?: string }).name)
    .filter((name): name is string => !!name && !name.startsWith('_'));
  const distinctUnits = [...new Set(profileSeries.map(({ data: item }) => item.unit))];
  const distinctTypes = [...new Set(profileSeries.map(({ data: item }) => item.measurement_type))];
  const yAxisName = distinctUnits.length === 1 && distinctTypes.length === 1
    ? `${distinctTypes[0]} (${distinctUnits[0]})`
    : 'Wert';

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
      data: legendData,
      textStyle: { color: theme.mutedText },
      top: 0,
      type: 'scroll',
    },
    grid: { left: Y_AXIS_GRID_LEFT, right: DATA_ZOOM_Y_GRID_RIGHT, top: 52, bottom: 58, containLabel: true },
    xAxis: {
      type: 'category',
      data: allHours.map(formatHour),
      axisLabel: { color: theme.mutedText, rotate: 45, fontSize: 10 },
      axisLine: { lineStyle: { color: theme.axis } },
    },
    yAxis: {
      ...scaledValueAxis(yScale),
      name: yAxisName,
      ...yAxisNameStyle(theme.mutedText),
      axisLabel: { color: theme.mutedText, formatter: formatChartNumber },
      axisLine: { lineStyle: { color: theme.axis } },
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
    series,
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
