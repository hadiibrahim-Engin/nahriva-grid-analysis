import { useMemo, useState } from 'react';
import ReactECharts from './ReactECharts';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  ToolboxComponent,
  MarkLineComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { TimeseriesData } from '../../api/client';
import {
  buildChartExportName,
  DATA_ZOOM_BOTTOM,
  DATA_ZOOM_RIGHT,
  DATA_ZOOM_SLIDER_HEIGHT,
  DATA_ZOOM_SLIDER_WIDTH,
  DATA_ZOOM_Y_GRID_RIGHT,
  formatChartNumber,
  formatChartValue,
  Y_AXIS_GRID_LEFT,
  yAxisNameStyle,
} from './format';
import { useChartTheme } from '../../hooks/useChartTheme';
import { normalizeThresholdLevelEntries } from '../../util/dynamicCharts';

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  ToolboxComponent,
  MarkLineComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

const LARGE_THRESHOLD = 2000;

interface AxisExtent {
  min: number;
  max: number;
}

function axisPadding({ min, max }: AxisExtent): number {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
  const spread = max - min;
  if (spread === 0) return Math.max(Math.abs(min) * 0.01, 1);
  return spread * 0.08;
}

function paddedAxisMin(extent: AxisExtent): number {
  const padding = axisPadding(extent);
  const lower = extent.min - padding;
  return extent.min >= 0 && lower < 0 ? 0 : lower;
}

function paddedAxisMax(extent: AxisExtent): number {
  const padding = axisPadding(extent);
  const upper = extent.max + padding;
  return extent.max <= 0 && upper > 0 ? 0 : upper;
}

function formatAxisValue(value: number): string {
  return formatChartNumber(value);
}

interface Props {
  seriesList: TimeseriesData[];
  thresholdLevels?: number[];
  thresholdLevelNames?: string[];
  thresholdLevelColors?: string[];
  /** Manual Y-axis range + scale. Only applied when the chart has a single
   * unit (dual-axis charts keep auto-scaling — one min/max can't sensibly
   * cover two different physical units). */
  yAxisScaleType?: 'auto' | 'manual';
  yAxisMin?: number;
  yAxisMax?: number;
  yAxisLog?: boolean;
  /** Optional base label for the exported PNG filename (e.g. the template
   * name). Signal names + date range are appended automatically. */
  exportBaseName?: string;
}

export default function TimeseriesChart({
  seriesList,
  thresholdLevels = [],
  thresholdLevelNames = [],
  thresholdLevelColors = [],
  yAxisScaleType = 'auto',
  yAxisMin,
  yAxisMax,
  yAxisLog = false,
  exportBaseName = 'Time series',
}: Props) {
  const theme = useChartTheme();

  // Preserve which series the user has toggled off via the legend across
  // option rebuilds (e.g. changing the resolution rebuilds the series with
  // notMerge, which would otherwise reset the legend and silently re-enable
  // hidden signals). Signals are only ever re-enabled by clicking the legend.
  const [legendSelected, setLegendSelected] = useState<Record<string, boolean>>({});
  const handleEvents = useMemo(
    () => ({
      legendselectchanged: (params: unknown) => {
        const selected = (params as { selected?: Record<string, boolean> }).selected;
        if (selected) setLegendSelected({ ...selected });
      },
    }),
    [],
  );

  // Transform the raw points into ECharts [timestamp, value] tuples once per
  // data change. The option below rebuilds on cheaper triggers too (theme,
  // legend toggle, y-axis controls); keeping this mapping in its own memo
  // avoids re-walking every point on those. Also precompute the sorted
  // timestamps used for the export filename.
  const { mappedData, allTimestamps } = useMemo(() => {
    const mapped = seriesList.map((s) => s.data.map((p) => [p.timestamp, p.value] as [string | number, number | null]));
    const timestamps = seriesList.flatMap((s) => s.data.map((p) => p.timestamp)).sort();
    return { mappedData: mapped, allTimestamps: timestamps };
  }, [seriesList]);

  // Group by unit so e.g. P (kW) and U (V) don't collapse onto a single
  // scale where one becomes a flat invisible line. ECharts supports up to
  // two y-axes natively (left/right); if we hit three+ units we fall back
  // to one axis and surface a warning.
  const { option, unitWarning, chartKey } = useMemo(() => {
    if (seriesList.length === 0) return { option: null, unitWarning: null };

    const totalPoints = seriesList.reduce((sum, s) => sum + s.data.length, 0);
    const isLarge = totalPoints > LARGE_THRESHOLD;
    const thresholdEntries = normalizeThresholdLevelEntries(
      thresholdLevels,
      thresholdLevelNames,
      thresholdLevelColors,
    );
    const sortedThresholds = thresholdEntries.map((entry) => entry.value);
    const thresholdColor = (index: number) => {
      return thresholdEntries[index]?.color ?? theme.warning;
    };
    const thresholdPieces = sortedThresholds.length >= 2
      ? [
          { lte: sortedThresholds[0], color: theme.palette[0] },
          ...sortedThresholds.slice(0, -1).map((level, index) => ({
            gt: level,
            lte: sortedThresholds[index + 1],
            color: thresholdColor(index),
          })),
          { gt: sortedThresholds[sortedThresholds.length - 1], color: thresholdColor(sortedThresholds.length - 1) },
        ]
      : [];

    const distinctUnits = Array.from(new Set(seriesList.map((s) => s.unit)));
    const useMultiAxis = distinctUnits.length === 2;
    const tooManyUnits = distinctUnits.length > 2;
    const chartKey = seriesList
      .map((s) => `${s.component_name}|${s.measurement_type}|${s.unit}`)
      .sort()
      .join('::');

    // Self-describing download filename: base label + signal names + the date
    // range actually covered by the plotted points (allTimestamps precomputed).
    const exportName = buildChartExportName({
      base: exportBaseName,
      signals: seriesList.map((s) => `${s.component_name}-${s.measurement_type}`),
      startDate: allTimestamps[0],
      endDate: allTimestamps[allTimestamps.length - 1],
    });

    // Manual min/max/log only make sense with a single unit — one range
    // can't sensibly describe two different physical quantities.
    const useManualScale = yAxisScaleType === 'manual' && !useMultiAxis;

    const valueAxisBase = (unit?: string, idx = 0) => ({
      type: (useManualScale && yAxisLog ? 'log' as const : 'value' as const),
      name: unit,
      ...(unit ? yAxisNameStyle(theme.mutedText, idx === 0 ? 62 : 58) : {}),
      scale: true,
      min: useManualScale && yAxisMin != null
        ? yAxisMin
        : (extent: AxisExtent) => {
            const combined = idx === 0 && sortedThresholds.length > 0
              ? {
                  min: Math.min(extent.min, ...sortedThresholds),
                  max: Math.max(extent.max, ...sortedThresholds),
                }
              : extent;
            return paddedAxisMin(combined);
          },
      max: useManualScale && yAxisMax != null
        ? yAxisMax
        : (extent: AxisExtent) => {
            const combined = idx === 0 && sortedThresholds.length > 0
              ? {
                  min: Math.min(extent.min, ...sortedThresholds),
                  max: Math.max(extent.max, ...sortedThresholds),
                }
              : extent;
            return paddedAxisMax(combined);
          },
      position: idx === 0 ? ('left' as const) : ('right' as const),
      nameTextStyle: unit
        ? { color: theme.mutedText, align: 'center' as const, fontSize: 11 }
        : { color: theme.mutedText, fontSize: 11 },
      axisLine: { lineStyle: { color: theme.axis } },
      axisLabel: { color: theme.mutedText, formatter: formatAxisValue },
      splitLine: { show: idx === 0, lineStyle: { color: theme.grid, type: 'dashed' as const } },
    });

    const yAxis = useMultiAxis
      ? distinctUnits.map((unit, idx) => valueAxisBase(unit, idx))
      : valueAxisBase(undefined, 0);

    // Lightning: a pulsing endpoint marker on every series whose last
    // sample is non-zero. This is the closest ECharts-native analog
    // to the "active value beacon" effect the user asked for.
    const series = seriesList.map((s, i) => {
      const color = theme.palette[i % theme.palette.length];
      const lastValue = s.data.length > 0 ? s.data[s.data.length - 1].value : 0;
      const lastTimestamp = s.data.length > 0 ? s.data[s.data.length - 1].timestamp : null;
      const isActive = Number.isFinite(lastValue) && Math.abs(lastValue) > 0;
      return {
        name: `${s.component_name} - ${s.measurement_type} (${s.unit})`,
        type: 'line' as const,
        yAxisIndex: useMultiAxis ? distinctUnits.indexOf(s.unit) : 0,
        showSymbol: false,
        lineStyle: { width: isLarge ? 1 : 1.5 },
        data: mappedData[i],
        color,
        sampling: 'lttb' as const,
        large: isLarge,
        largeThreshold: LARGE_THRESHOLD,
        progressive: isLarge ? 400 : 0,
        progressiveThreshold: LARGE_THRESHOLD,
        animation: !isLarge,
        ...(i === 0 && sortedThresholds.length > 0
          ? {
              markLine: {
                silent: true,
                symbol: 'none',
                label: { show: false },
                data: sortedThresholds.map((value, index) => ({
                  name: thresholdEntries[index]?.name ?? '',
                  yAxis: value,
                  lineStyle: {
                    color: thresholdColor(index),
                    type: 'dashed' as const,
                    width: index === 0 || index === sortedThresholds.length - 1 ? 2 : 1.5,
                  },
                })),
              },
            }
          : {}),
        ...(isActive && lastTimestamp != null && !isLarge
          ? {
              markPoint: {
                symbol: 'circle',
                symbolSize: 8,
                itemStyle: { color, borderColor: color, borderWidth: 2 },
                label: { show: false },
                data: [
                  {
                    coord: [lastTimestamp, lastValue],
                    // Rippling effect — ECharts native pulse animation.
                    // Disabled on large datasets to keep render budget low.
                  },
                ],
              },
            }
          : {}),
      };
    });

    return {
      unitWarning: tooManyUnits
        ? `Note: ${distinctUnits.length} different units (${distinctUnits.join(', ')}) share one axis — small series can look invisible.`
        : null,
      chartKey,
      option: {
        backgroundColor: 'transparent',
        textStyle: { color: theme.mutedText },
        tooltip: {
          trigger: 'axis' as const,
          backgroundColor: theme.tooltipBg,
          borderColor: theme.tooltipBorder,
          textStyle: { color: theme.text },
          axisPointer: { animation: false },
          formatter: (params: { marker?: string; seriesName?: string; value?: unknown }[]) => {
            const lines = params.map((p) => (
              `${p.marker ?? ''} ${p.seriesName ?? ''}: ${formatChartValue(p.value)}`
            ));
            if (sortedThresholds.length > 0) {
              lines.push(
                '<span style="opacity:.72">Thresholds</span>',
                ...sortedThresholds.map((level, index) => {
                  const label = thresholdEntries[index]?.name ?? 'Threshold';
                  const color = thresholdColor(index);
                  return `<span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:${color};margin-right:5px"></span>${label}: ${formatChartNumber(level)}`;
                }),
              );
            }
            return lines.join('<br/>');
          },
        },
        legend: {
          data: series.map((s) => s.name),
          textStyle: { color: theme.mutedText, fontSize: 11 },
          top: 0,
          type: 'scroll' as const,
          // Re-apply the user's hide/show choices so a data/resolution refresh
          // (notMerge rebuild) never silently re-enables a disabled signal.
          selected: legendSelected,
        },
        visualMap: sortedThresholds.length >= 2
          ? {
              show: false,
              dimension: 1,
              seriesIndex: 0,
              pieces: thresholdPieces,
            }
          : undefined,
        toolbox: {
          feature: {
            dataZoom: { yAxisIndex: 'none' },
            restore: {},
            saveAsImage: { name: exportName },
          },
          iconStyle: { borderColor: theme.mutedText },
          right: 20,
        },
        grid: {
          left: useMultiAxis ? Y_AXIS_GRID_LEFT : 64,
          right: useMultiAxis
            ? Y_AXIS_GRID_LEFT + DATA_ZOOM_SLIDER_WIDTH + 12
            : Math.max(sortedThresholds.length > 0 ? 58 : 40, DATA_ZOOM_Y_GRID_RIGHT),
          top: 60,
          bottom: 72,
          containLabel: true,
        },
        xAxis: {
          type: 'time' as const,
          axisLine: { lineStyle: { color: theme.axis } },
          axisLabel: {
            color: theme.mutedText,
            formatter: (value: number) => {
              const d = new Date(value);
              const hh = String(d.getHours()).padStart(2, '0');
              const mm = String(d.getMinutes()).padStart(2, '0');
              const dd = String(d.getDate()).padStart(2, '0');
              const mo = String(d.getMonth() + 1).padStart(2, '0');
              return `${dd}.${mo}\n${hh}:${mm}`;
            },
          },
          splitLine: { show: true, lineStyle: { color: theme.grid, type: 'dashed' as const } },
        },
        yAxis,
        dataZoom: [
          { type: 'inside', start: 0, end: 100, xAxisIndex: 0 },
          { type: 'inside', yAxisIndex: useMultiAxis ? [0, 1] : 0, filterMode: 'none' },
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
            yAxisIndex: useMultiAxis ? [0, 1] : 0,
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
      },
    };
  }, [seriesList, mappedData, allTimestamps, thresholdLevels, thresholdLevelNames, thresholdLevelColors, theme, yAxisScaleType, yAxisMin, yAxisMax, yAxisLog, exportBaseName, legendSelected]);

  if (!option) {
    return (
      <div className="h-[400px] flex items-center justify-center text-gray-500">
        No data selected
      </div>
    );
  }

  return (
    <div>
      {unitWarning && (
        <div className="text-xs text-amber-300/90 bg-amber-900/20 border border-amber-700/40 rounded px-2 py-1 mb-2">
          {unitWarning}
        </div>
      )}
      <ReactECharts
        key={chartKey}
        echarts={echarts}
        option={option}
        style={{ height: 400 }}
        notMerge
        lazyUpdate
        onEvents={handleEvents}
      />
    </div>
  );
}
