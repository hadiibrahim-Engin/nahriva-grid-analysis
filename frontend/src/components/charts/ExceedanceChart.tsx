import ReactECharts from './ReactECharts';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ExceedanceData } from '../../api/client';
import {
  DATA_ZOOM_BOTTOM,
  DATA_ZOOM_RIGHT,
  DATA_ZOOM_SLIDER_HEIGHT,
  DATA_ZOOM_SLIDER_WIDTH,
  DATA_ZOOM_Y_GRID_RIGHT,
  formatChartNumber,
  formatChartPercent,
  scaledValueAxis,
  type YAxisScaleProps,
} from './format';
import { useChartTheme } from '../../hooks/useChartTheme';

echarts.use([BarChart, LineChart, DataZoomComponent, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

interface Props {
  data: ExceedanceData;
}

export default function ExceedanceChart({ data, ...yScale }: Props & YAxisScaleProps) {
  const theme = useChartTheme();
  const hours = Math.floor(data.total_minutes_above / 60);
  const mins = Math.round(data.total_minutes_above % 60);
  const topDays = data.top_days.slice(0, 10);
  const chartDays = [...topDays].sort((a, b) => a.day.localeCompare(b.day));
  const hasExceedances = chartDays.length > 0;
  const chartOption = {
    backgroundColor: 'transparent',
    color: [theme.warning, theme.danger],
    textStyle: { color: theme.mutedText },
    tooltip: {
      trigger: 'axis',
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text },
      formatter: (params: { marker?: string; seriesName?: string; dataIndex: number; value: number }[]) => {
        const index = params[0]?.dataIndex ?? 0;
        const day = chartDays[index];
        if (!day) return '';
        const h = Math.floor(day.minutes_above / 60);
        const m = Math.round(day.minutes_above % 60);
        const duration = h > 0 ? `${h}h ${m}m` : `${m}m`;
        return [
          `<strong>${day.day}</strong>`,
          `${params[0]?.marker ?? ''} Dauer: ${duration}`,
          `${params[1]?.marker ?? ''} Max: ${formatChartNumber(day.max_value)} ${data.unit}`,
          `Mittel: ${formatChartNumber(day.mean_value)} ${data.unit}`,
          `Schwellwert: ${formatChartNumber(data.threshold)} ${data.unit}`,
        ].join('<br/>');
      },
    },
    legend: {
      top: 0,
      textStyle: { color: theme.mutedText },
      data: ['Dauer über Schwellwert', 'Maximalwert'],
    },
    grid: { left: 56, right: DATA_ZOOM_Y_GRID_RIGHT, top: 48, bottom: chartDays.length > 6 ? 66 : 44, containLabel: true },
    xAxis: {
      type: 'category',
      data: chartDays.map((d) => d.day),
      axisLabel: { color: theme.mutedText, rotate: chartDays.length > 6 ? 35 : 0, fontSize: 10 },
      axisLine: { lineStyle: { color: theme.axis } },
    },
    yAxis: [
      {
        ...scaledValueAxis(yScale),
        name: 'Dauer (min)',
        nameTextStyle: { color: theme.mutedText },
        axisLabel: { color: theme.mutedText, formatter: formatChartNumber },
        axisLine: { lineStyle: { color: theme.axis } },
        splitLine: { lineStyle: { color: theme.grid } },
      },
      {
        type: 'value',
        name: `${data.measurement_type} (${data.unit})`,
        nameTextStyle: { color: theme.mutedText },
        axisLabel: { color: theme.mutedText, formatter: formatChartNumber },
        axisLine: { lineStyle: { color: theme.axis } },
        splitLine: { show: false },
      },
    ],
    dataZoom: chartDays.length > 6
      ? [
          { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
          { type: 'inside', yAxisIndex: [0, 1], filterMode: 'none' },
          {
            type: 'slider',
            xAxisIndex: 0,
            height: DATA_ZOOM_SLIDER_HEIGHT,
            bottom: DATA_ZOOM_BOTTOM,
            filterMode: 'none',
          },
          {
            type: 'slider',
            yAxisIndex: [0, 1],
            width: DATA_ZOOM_SLIDER_WIDTH,
            right: DATA_ZOOM_RIGHT,
            filterMode: 'none',
            borderColor: theme.axis,
            backgroundColor: theme.isLight ? '#ffffff' : '#111827',
            textStyle: { color: theme.mutedText },
          },
        ]
      : [
          { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
          { type: 'inside', yAxisIndex: [0, 1], filterMode: 'none' },
          {
            type: 'slider',
            yAxisIndex: [0, 1],
            width: DATA_ZOOM_SLIDER_WIDTH,
            right: DATA_ZOOM_RIGHT,
            filterMode: 'none',
            borderColor: theme.axis,
            backgroundColor: theme.isLight ? '#ffffff' : '#111827',
            textStyle: { color: theme.mutedText },
          },
        ],
    series: [
      {
        name: 'Dauer über Schwellwert',
        type: 'bar',
        barMaxWidth: 34,
        itemStyle: {
          borderRadius: [4, 4, 0, 0],
          color: theme.warning,
        },
        data: chartDays.map((d) => d.minutes_above),
      },
      {
        name: 'Maximalwert',
        type: 'line',
        yAxisIndex: 1,
        symbolSize: 7,
        lineStyle: { width: 2, color: theme.danger },
        itemStyle: { color: theme.danger },
        markLine: {
          symbol: 'none',
          lineStyle: { type: 'dashed', color: theme.danger, opacity: 0.55 },
          label: { show: false },
          data: [{ yAxis: data.threshold }],
        },
        data: chartDays.map((d) => d.max_value),
      },
    ],
  };

  return (
    <div className="space-y-3">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-gray-700/50 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-yellow-400">
            {hours > 0 ? `${hours}h ${mins}m` : `${mins}m`}
          </div>
          <div className="text-xs text-gray-400">Gesamtdauer &gt; {formatChartNumber(data.threshold)} {data.unit}</div>
        </div>
        <div className="bg-gray-700/50 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-red-400">{formatChartPercent(data.total_pct)}</div>
          <div className="text-xs text-gray-400">Anteil der Gesamtzeit</div>
        </div>
        <div className="bg-gray-700/50 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-blue-400">{data.top_days.length}</div>
          <div className="text-xs text-gray-400">Betroffene Tage</div>
        </div>
      </div>

      {hasExceedances ? (
        <div className="rounded-lg border border-[var(--grid-border)] bg-[var(--grid-surface-soft)] p-3">
          <ReactECharts
            echarts={echarts}
            option={chartOption}
            style={{ height: 340 }}
            notMerge
            lazyUpdate
          />
        </div>
      ) : (
        <div className="rounded-lg border border-[var(--grid-border)] bg-[var(--grid-surface-soft)] px-3 py-6 text-center text-sm text-[var(--grid-muted)]">
          Keine Überschreitungen über {formatChartNumber(data.threshold)} {data.unit} im gewählten Zeitraum.
        </div>
      )}

      {/* Top days table */}
      {topDays.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-[var(--grid-border)] bg-[var(--grid-surface-soft)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--grid-border)] text-[var(--grid-muted)]">
                <th className="text-left py-1.5 px-2">#</th>
                <th className="text-left py-1.5 px-2">Tag</th>
                <th className="text-right py-1.5 px-2">Dauer</th>
                <th className="text-right py-1.5 px-2">Max</th>
                <th className="text-right py-1.5 px-2">Mittel</th>
              </tr>
            </thead>
            <tbody>
              {topDays.map((d, i) => {
                const h = Math.floor(d.minutes_above / 60);
                const m = Math.round(d.minutes_above % 60);
                return (
                  <tr key={d.day} className="border-b border-[var(--grid-border-soft)] hover:bg-[var(--grid-control-hover)]">
                    <td className="py-1.5 px-2 text-[var(--grid-muted)]">{i + 1}</td>
                    <td className="py-1.5 px-2 font-mono text-[var(--grid-text)]">{d.day}</td>
                    <td className="py-1.5 px-2 text-right text-yellow-400">
                      {h > 0 ? `${h}h ${m}m` : `${m}m`}
                    </td>
                    <td className="py-1.5 px-2 text-right text-red-400">{formatChartNumber(d.max_value)} {data.unit}</td>
                    <td className="py-1.5 px-2 text-right text-[var(--grid-text-soft)]">{formatChartNumber(d.mean_value)} {data.unit}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
