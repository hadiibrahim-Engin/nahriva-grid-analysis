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
import type { HeatmapData } from '../../api/client';
import { DATA_ZOOM_SLIDER_WIDTH, formatChartNumber } from './format';
import { useChartTheme } from '../../hooks/useChartTheme';

echarts.use([EHeatmapChart, GridComponent, TooltipComponent, VisualMapComponent, DataZoomComponent, CanvasRenderer]);

const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const HOURS = Array.from({ length: 24 }, (_, i) => `${i}:00`);

interface Props {
  data: HeatmapData;
}

export default function HeatmapChart({ data }: Props) {
  const theme = useChartTheme();
  const values = data.data.map((c) => c.value);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);

  const heatmapData = data.data.map((c) => [c.hour, c.day_of_week, c.value]);

  // Heatmap palette: low (cool) → mid (primary) → high (warning) → peak (danger).
  // Picked from the theme tokens so it works in both modes.
  // Light mode starts from a neutral tint (not blue) and uses a softened primary,
  // so low cells stay calm on the white surface and the warm end carries the signal.
  const heatmapRamp = theme.isLight
    ? ['#EEF0F6', '#BDB6FA', theme.warning, theme.danger]
    : ['#1e3a5f', theme.primary, theme.warning, theme.danger];

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text },
      formatter: (params: { value: number[] }) => {
        const [hour, day, val] = params.value;
        return `${DAYS[day]} ${hour}:00<br/>${formatChartNumber(val)} ${data.unit}`;
      },
    },
    grid: { left: 50, right: 108, top: 10, bottom: 40 },
    xAxis: {
      type: 'category',
      data: HOURS,
      axisLabel: { color: theme.mutedText, fontSize: 10 },
      splitArea: { show: true, areaStyle: { color: ['transparent'] } },
    },
    yAxis: {
      type: 'category',
      data: DAYS,
      // ECharts plots category index 0 at the axis origin (bottom), which would
      // render the week bottom-up (Mo at the bottom → reads Sun→Mon top-down).
      // Invert so Monday sits at the top and the rows read Mon→Sun downward.
      inverse: true,
      axisLabel: { color: theme.mutedText },
      splitArea: { show: true, areaStyle: { color: ['transparent'] } },
    },
    visualMap: {
      min: minVal,
      max: maxVal,
      calculable: true,
      orient: 'vertical',
      right: 0,
      top: 'center',
      inRange: { color: heatmapRamp },
      formatter: formatChartNumber,
      textStyle: { color: theme.mutedText },
    },
    dataZoom: [
      { type: 'inside' as const, yAxisIndex: 0, filterMode: 'none' as const },
      {
        type: 'slider' as const,
        yAxisIndex: 0,
        width: DATA_ZOOM_SLIDER_WIDTH,
        right: 48,
        filterMode: 'none' as const,
        borderColor: theme.axis,
        backgroundColor: theme.isLight ? '#ffffff' : '#111827',
        textStyle: { color: theme.mutedText },
      },
    ],
    series: [
      {
        type: 'heatmap',
        data: heatmapData,
        label: { show: false },
        emphasis: {
          itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0, 0, 0, 0.5)' },
        },
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
