import { useMemo, useState } from 'react';
import ReactECharts from './ReactECharts';
import * as echarts from 'echarts/core';
import { HeatmapChart as EHeatmapChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  VisualMapComponent,
  DataZoomComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { QualityData } from '../../api/client';
import { useChartTheme } from '../../hooks/useChartTheme';
import { DATA_ZOOM_SLIDER_WIDTH } from './format';

echarts.use([EHeatmapChart, GridComponent, TooltipComponent, VisualMapComponent, DataZoomComponent, CanvasRenderer]);

interface Props {
  data: QualityData;
}

export default function QualityChart({ data }: Props) {
  const theme = useChartTheme();
  const [selectedType, setSelectedType] = useState(data.measurement_types[0] || 'P');

  const option = useMemo(() => {
    // Filter gap heatmap for selected type
    const cells = data.gap_heatmap.filter((c) => c.measurement_type === selectedType);
    const days = [...new Set(cells.map((c) => c.day))].sort();
    const hours = Array.from({ length: 24 }, (_, i) => i);

    // Expected per hour (4 for 15-min resolution)
    const expectedPerHour = 4;

    const heatData = cells.map((c) => {
      const dayIdx = days.indexOf(c.day);
      return [c.hour, dayIdx, c.count];
    });

    return {
      backgroundColor: 'transparent',
      textStyle: { color: theme.mutedText },
      tooltip: {
        position: 'top' as const,
        backgroundColor: theme.tooltipBg,
        borderColor: theme.tooltipBorder,
        textStyle: { color: theme.text },
        formatter: (p: { data: number[] }) => {
          const [hour, dayIdx, cnt] = p.data;
          return `${days[dayIdx]} ${hour}:00<br/>Werte: ${cnt} / ${expectedPerHour}<br/>Fehlend: ${Math.max(0, expectedPerHour - cnt)}`;
        },
      },
      grid: { left: 90, right: 34, top: 10, bottom: 60 },
      xAxis: {
        type: 'category' as const,
        data: hours.map((h) => `${h}:00`),
        axisLabel: { color: theme.mutedText, fontSize: 10 },
        axisLine: { lineStyle: { color: theme.axis } },
        splitArea: { show: true, areaStyle: { color: ['transparent', 'rgba(255,255,255,0.02)'] } },
      },
      yAxis: {
        type: 'category' as const,
        data: days,
        axisLabel: { color: theme.mutedText, fontSize: 10 },
        axisLine: { lineStyle: { color: theme.axis } },
      },
      visualMap: {
        min: 0,
        max: expectedPerHour,
        calculable: false,
        orient: 'horizontal' as const,
        left: 'center',
        bottom: 0,
        inRange: {
          color: [theme.danger, theme.warning, theme.success],
        },
        textStyle: { color: theme.mutedText },
      },
      dataZoom: [
        { type: 'inside' as const, yAxisIndex: 0, filterMode: 'none' as const },
        {
          type: 'slider',
          yAxisIndex: 0,
          right: 10,
          width: DATA_ZOOM_SLIDER_WIDTH,
          filterMode: 'none',
          borderColor: theme.axis,
          textStyle: { color: theme.mutedText },
        },
      ],
      series: [{
        type: 'heatmap' as const,
        data: heatData,
        label: { show: false },
        emphasis: { itemStyle: { shadowBlur: 5, shadowColor: 'rgba(0, 0, 0, 0.5)' } },
      }],
    };
  }, [data, selectedType, theme]);

  return (
    <div>
      <div className="flex gap-2 mb-2">
        {data.measurement_types.map((t) => (
          <button
            key={t}
            onClick={() => setSelectedType(t)}
            className={`text-xs px-2 py-1 rounded ${selectedType === t ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}
          >
            {t}
          </button>
        ))}
      </div>
      <ReactECharts
        echarts={echarts}
        option={option}
        style={{ height: Math.max(300, [...new Set(data.gap_heatmap.filter((c) => c.measurement_type === selectedType).map((c) => c.day))].length * 18 + 80) }}
        notMerge
        lazyUpdate
      />
    </div>
  );
}
