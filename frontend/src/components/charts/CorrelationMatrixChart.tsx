/**
 * CorrelationMatrixChart - NxN heatmap of Pearson correlations.
 *
 * Renders a symmetric correlation matrix as an ECharts heatmap.
 * Cell color ranges from blue (-1) through white (0) to red (+1).
 */
import ReactECharts from './ReactECharts';
import * as echarts from 'echarts/core';
import { HeatmapChart as EHeatmapChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { CorrelationMatrixData } from '../../api/client';
import { DATA_ZOOM_SLIDER_WIDTH, formatChartNumber } from './format';
import { useChartTheme } from '../../hooks/useChartTheme';

echarts.use([EHeatmapChart, GridComponent, TooltipComponent, VisualMapComponent, DataZoomComponent, CanvasRenderer]);

const MTYPE_LABELS: Record<string, string> = {
  P: 'P (MW)', Q: 'Q (Mvar)', S: 'S (MVA)', U: 'U (p.u.)', I: 'I (A)', loading: 'Loading (%)',
};

interface Props {
  data: CorrelationMatrixData;
}

export default function CorrelationMatrixChart({ data }: Props) {
  const theme = useChartTheme();
  const labels = data.types.map((t) => MTYPE_LABELS[t] || t);
  const n = data.types.length;

  // Build [x, y, value] array for the heatmap. A null cell (no data for that
  // pair) is passed through as null so ECharts renders an empty cell rather
  // than a misleading 0.0.
  const heatData: [number, number, number | null][] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      heatData.push([j, i, data.matrix[i][j]]);
    }
  }

  // Diverging palette: primary (blue, neg) → neutral mid → danger (red, pos).
  // The neutral mid mirrors the tooltipBg / surface tone of the active theme.
  const divergingMid = theme.isLight ? '#e5ebf2' : '#1e293b';

  const option = {
    backgroundColor: 'transparent',
    textStyle: { color: theme.mutedText },
    tooltip: {
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text },
      formatter: (params: { value: [number, number, number | null] }) => {
        const [x, y, r] = params.value;
        const rText = r == null ? 'no data' : formatChartNumber(r);
        return `${labels[y]} vs ${labels[x]}<br/>r = <b>${rText}</b>`;
      },
    },
    grid: { left: 100, right: 104, top: 20, bottom: 60 },
    xAxis: {
      type: 'category',
      data: labels,
      splitArea: { show: true },
      axisLabel: { color: theme.mutedText, rotate: 30, fontSize: 11 },
      axisLine: { lineStyle: { color: theme.axis } },
    },
    yAxis: {
      type: 'category',
      data: labels,
      splitArea: { show: true },
      axisLabel: { color: theme.mutedText, fontSize: 11 },
      axisLine: { lineStyle: { color: theme.axis } },
    },
    visualMap: {
      min: -1, max: 1,
      calculable: true,
      orient: 'vertical',
      right: 0, top: 'center',
      textStyle: { color: theme.mutedText },
      formatter: formatChartNumber,
      inRange: {
        color: [theme.primary, divergingMid, theme.danger],
      },
    },
    dataZoom: [
      { type: 'inside' as const, yAxisIndex: 0, filterMode: 'none' as const },
      {
        type: 'slider' as const,
        yAxisIndex: 0,
        width: DATA_ZOOM_SLIDER_WIDTH,
        right: 46,
        filterMode: 'none' as const,
        borderColor: theme.axis,
        backgroundColor: theme.isLight ? '#ffffff' : '#111827',
        textStyle: { color: theme.mutedText },
      },
    ],
    series: [{
      type: 'heatmap',
      data: heatData,
      label: {
        show: true,
        color: theme.text,
        fontSize: 11,
        formatter: (params: { value: [number, number, number | null] }) => (params.value[2] == null ? '–' : formatChartNumber(params.value[2])),
      },
      emphasis: {
        itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.5)' },
      },
    }],
  };

  const height = Math.max(300, n * 60 + 80);

  return (
    <ReactECharts
      echarts={echarts}
      option={option}
      style={{ height }}
      notMerge
      lazyUpdate
    />
  );
}
