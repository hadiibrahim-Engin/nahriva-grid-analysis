import ReactECharts from './ReactECharts';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import {
  DATA_ZOOM_BOTTOM,
  DATA_ZOOM_RIGHT,
  DATA_ZOOM_SLIDER_HEIGHT,
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

echarts.use([BarChart, GridComponent, TooltipComponent, DataZoomComponent, CanvasRenderer]);

export type PeakDemandPeriod = 'day' | 'week' | 'month';

export interface PeakDemandContribution {
  key: string;
  label: string;
  value: number;
  percent: number;
}

export interface PeakDemandRow {
  periodKey: string;
  periodLabel: string;
  timestamp: string;
  value: number;
  unit: string;
  contributions: PeakDemandContribution[];
}

interface Props {
  rows: PeakDemandRow[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}

function formatTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function PeakDemandChart({ rows, selectedIndex, onSelect, ...yScale }: Props & YAxisScaleProps) {
  const theme = useChartTheme();
  const needsZoom = rows.length > 30;
  const option = {
    backgroundColor: 'transparent',
    textStyle: { color: theme.mutedText },
    tooltip: {
      trigger: 'axis',
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text },
      formatter: (params: { dataIndex: number; value: number }[]) => {
        const index = params[0]?.dataIndex ?? 0;
        const row = rows[index];
        if (!row) return '';
        const top = row.contributions.slice(0, 4)
          .map((c) => `${c.label}: ${formatChartNumber(c.value)} ${row.unit} (${formatChartPercent(c.percent)})`)
          .join('<br/>');
        return [
          `<strong>${row.periodLabel}</strong>`,
          `Peak: ${formatChartNumber(row.value)} ${row.unit}`,
          `Zeitpunkt: ${formatTimestamp(row.timestamp)}`,
          top ? `<br/>${top}` : '',
        ].join('<br/>');
      },
    },
    grid: { left: Y_AXIS_GRID_LEFT, right: DATA_ZOOM_Y_GRID_RIGHT, top: 20, bottom: needsZoom ? 68 : 48, containLabel: true },
    xAxis: {
      type: 'category',
      data: rows.map((r) => r.periodLabel),
      axisLine: { lineStyle: { color: theme.axis } },
      axisLabel: {
        color: theme.mutedText,
        rotate: rows.length > 16 ? 45 : 0,
        fontSize: 11,
      },
    },
    yAxis: {
      ...scaledValueAxis(yScale),
      name: rows[0]?.unit ? `Peak (${rows[0].unit})` : 'Peak',
      ...yAxisNameStyle(theme.mutedText),
      axisLine: { lineStyle: { color: theme.axis } },
      axisLabel: { color: theme.mutedText, formatter: formatChartNumber },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    dataZoom: [
      ...(needsZoom ? [{ type: 'inside' as const, start: 0, end: 100, xAxisIndex: 0 }] : []),
      { type: 'inside' as const, yAxisIndex: 0, filterMode: 'none' as const },
      ...(needsZoom ? [
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
      ] : []),
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
        type: 'bar',
        data: rows.map((row, index) => ({
          value: row.value,
          itemStyle: { color: index === selectedIndex ? theme.warning : theme.primary },
        })),
        barMaxWidth: 22,
      },
    ],
  };

  return (
    <ReactECharts
      echarts={echarts}
      option={option}
      style={{ height: 320 }}
      notMerge
      lazyUpdate
      onEvents={{
        click: (params: unknown) => {
          const index = (params as { dataIndex?: number }).dataIndex;
          if (typeof index === 'number') onSelect(index);
        },
      }}
    />
  );
}
