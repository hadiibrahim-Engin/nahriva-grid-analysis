import { useMemo, useCallback, useRef, useState } from 'react';
import ReactECharts, { type ReactEChartsHandle } from './ReactECharts';
import * as echarts from 'echarts/core';
import { RadarChart } from 'echarts/charts';
import {
  TooltipComponent,
  LegendComponent,
  RadarComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { SeasonRadarData } from '../../api/client';
import { formatChartValue } from './format';
import { useChartTheme } from '../../hooks/useChartTheme';

echarts.use([RadarChart, TooltipComponent, LegendComponent, RadarComponent, CanvasRenderer]);

interface Props {
  data: SeasonRadarData;
}

type RadarMode = 'relative' | 'absolute' | 'profile';
type RadarSeries = SeasonRadarData['series'][number];

const MODES: { id: RadarMode; label: string; hint: string }[] = [
  { id: 'relative', label: 'Relativ', hint: 'Jahresmittel = 100' },
  { id: 'profile', label: 'Profil', hint: 'je Reihe 0-100' },
  { id: 'absolute', label: 'Absolut', hint: 'Originalwerte' },
];

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function transformValues(series: RadarSeries, mode: RadarMode): number[] {
  const values = series.monthly_medians;
  if (mode === 'absolute') return values;

  if (mode === 'profile') {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = max - min;
    if (spread === 0) return values.map(() => 50);
    return values.map((value) => ((value - min) / spread) * 100);
  }

  const baseline = mean(values);
  if (baseline === 0) return values.map(() => 0);
  return values.map((value) => (value / baseline) * 100);
}

function radarBounds(values: number[], mode: RadarMode): { min: number; max: number } {
  if (mode === 'profile') return { min: 0, max: 100 };

  if (mode === 'absolute') {
    const max = Math.max(...values, 1);
    return { min: 0, max: max * 1.08 };
  }

  const min = Math.min(...values, 100);
  const max = Math.max(...values, 100);
  const pad = Math.max((max - min) * 0.35, 2);
  return {
    min: Math.max(0, min - pad),
    max: max + pad,
  };
}

export default function SeasonRadarChart({ data }: Props) {
  const chartRef = useRef<ReactEChartsHandle>(null);
  const theme = useChartTheme();
  const [mode, setMode] = useState<RadarMode>('relative');

  const option = useMemo(() => {
    const transformedSeries = data.series.map((s) => ({
      source: s,
      values: transformValues(s, mode),
    }));
    const allValues = transformedSeries.flatMap((s) => s.values);
    const bounds = radarBounds(allValues, mode);

    const colorFor = (i: number) => theme.palette[i % theme.palette.length];

    return {
      backgroundColor: 'transparent',
      textStyle: { color: theme.mutedText },
      tooltip: {
        backgroundColor: theme.tooltipBg,
        borderColor: theme.tooltipBorder,
        textStyle: { color: theme.text },
        valueFormatter: formatChartValue,
      },
      legend: {
        data: data.series.map((s) => `${s.measurement_type} (${s.unit})`),
        textStyle: { color: theme.mutedText },
        bottom: 0,
      },
      radar: {
        indicator: data.months.map((m) => ({ name: m, min: bounds.min, max: bounds.max })),
        shape: 'polygon' as const,
        axisName: { color: theme.mutedText, fontSize: 11 },
        axisLine: { lineStyle: { color: theme.axis } },
        splitLine: { lineStyle: { color: theme.grid } },
        splitArea: { areaStyle: { color: ['transparent', 'rgba(59, 130, 246, 0.05)'] } },
      },
      series: [{
        type: 'radar' as const,
        data: transformedSeries.map(({ source, values }, i) => {
          const c = colorFor(i);
          return {
            name: `${source.measurement_type} (${source.unit})`,
            value: values,
            lineStyle: { color: c, width: 2.5 },
            areaStyle: { color: c, opacity: 0.08 },
            itemStyle: { color: c },
          };
        }),
      }],
    };
  }, [data, mode, theme]);

  const handleLegendChange = useCallback((raw: unknown) => {
    const params = raw as { selected: Record<string, boolean> };
    const inst = chartRef.current?.getEchartsInstance();
    if (!inst) return;

    const activeSeries = data.series.filter(
      (s) => params.selected[`${s.measurement_type} (${s.unit})`] !== false
    );
    if (activeSeries.length === 0) return;

    const activeValues = activeSeries.flatMap((s) => transformValues(s, mode));
    const bounds = radarBounds(activeValues, mode);

    inst.setOption({
      radar: {
        indicator: data.months.map((m) => ({ name: m, min: bounds.min, max: bounds.max })),
      },
    });
  }, [data, mode]);

  const activeMode = MODES.find((item) => item.id === mode) ?? MODES[0];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2 text-xs text-gray-400">
        <span className="mr-1 text-gray-500">{activeMode.hint}</span>
        <div className="inline-flex overflow-hidden rounded border border-gray-600">
          {MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setMode(item.id)}
              className={`px-2.5 py-1 transition-colors ${
                mode === item.id
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <ReactECharts
        ref={chartRef}
        echarts={echarts}
        option={option}
        style={{ height: 400 }}
        notMerge
        lazyUpdate
        onEvents={{ legendselectchanged: handleLegendChange }}
      />
    </div>
  );
}
