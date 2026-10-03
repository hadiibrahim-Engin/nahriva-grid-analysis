import { useRef } from 'react';
import ReactECharts, { type ReactEChartsHandle } from './ReactECharts';
import * as echarts from 'echarts/core';
import { TooltipComponent, VisualMapComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { Scatter3DChart } from 'echarts-gl/charts';
import { Grid3DComponent } from 'echarts-gl/components';
import { CORRELATION_METHOD_LABELS, CORRELATION_METHOD_SYMBOLS, type CorrelationScatterData3 } from '../../util/dynamicCharts';
import {
  formatChartNumber,
  scaledValueAxis,
  type YAxisScaleProps,
} from './format';
import { useChartTheme } from '../../hooks/useChartTheme';

// Named camera angles for the reset/preset view buttons — mouse-drag still
// rotates freely, these just make it easy to get back to a legible angle
// instead of hunting for one by hand. alpha = tilt from horizontal (0 =
// looking straight at a side, 90 = looking straight down), beta = spin
// around the vertical axis.
const VIEW_PRESETS = {
  standard: { alpha: 24, beta: 38, distance: 178 },
  top: { alpha: 90, beta: 0, distance: 178 },
  front: { alpha: 0, beta: 0, distance: 178 },
  side: { alpha: 0, beta: 90, distance: 178 },
} as const;
type ViewPreset = keyof typeof VIEW_PRESETS;

echarts.use([Scatter3DChart, Grid3DComponent, TooltipComponent, VisualMapComponent, CanvasRenderer]);

const MTYPE_LABELS: Record<string, string> = {
  P: 'Active power', Q: 'Reactive power', S: 'Apparent power',
  U: 'Voltage', I: 'Current', loading: 'Loading',
};

type CorrelationData3D = CorrelationScatterData3 & {
  label_x?: string;
  label_y?: string;
  label_z?: string;
};

interface Props {
  data: CorrelationData3D;
}

function axisStyle(theme: ReturnType<typeof useChartTheme>) {
  return {
    axisLabel: { color: theme.mutedText, formatter: formatChartNumber },
    axisLine: { lineStyle: { color: theme.axis } },
    splitLine: { lineStyle: { color: theme.grid } },
    nameTextStyle: { color: theme.mutedText },
  };
}

export default function Correlation3DChart({ data, ...yScale }: Props & YAxisScaleProps) {
  const theme = useChartTheme();
  const chartRef = useRef<ReactEChartsHandle>(null);
  const applyView = (view: ViewPreset) => {
    chartRef.current?.getEchartsInstance()?.setOption({ grid3D: { viewControl: VIEW_PRESETS[view] } });
  };
  const labelX = data.label_x ?? MTYPE_LABELS[data.type_x] ?? data.type_x;
  const labelY = data.label_y ?? MTYPE_LABELS[data.type_y] ?? data.type_y;
  const labelZ = data.label_z ?? MTYPE_LABELS[data.type_z] ?? data.type_z;
  const zValues = data.data.map((point) => point.z);
  const zMin = Math.min(...zValues);
  const zMax = Math.max(...zValues);
  const visualMin = zMin === zMax ? zMin - 1 : zMin;
  const visualMax = zMin === zMax ? zMax + 1 : zMax;

  const direction = Math.abs(data.correlation) > 0.7
    ? 'Strong'
    : Math.abs(data.correlation) > 0.4
      ? 'Moderate'
      : 'Weak';
  const method = data.method ?? 'pearson';
  const methodSymbol = CORRELATION_METHOD_SYMBOLS[method];

  const commonAxisStyle = axisStyle(theme);
  const option = {
    backgroundColor: 'transparent',
    textStyle: { color: theme.mutedText },
    tooltip: {
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text },
      formatter: (params: { value: number[] }) => (
        `${labelX}: ${formatChartNumber(params.value[0])} ${data.unit_x}<br/>` +
        `${labelY}: ${formatChartNumber(params.value[1])} ${data.unit_y}<br/>` +
        `${labelZ}: ${formatChartNumber(params.value[2])} ${data.unit_z}`
      ),
    },
    visualMap: {
      type: 'continuous' as const,
      dimension: 2,
      min: visualMin,
      max: visualMax,
      calculable: true,
      orient: 'horizontal' as const,
      left: 'center' as const,
      top: 0,
      text: [`${labelZ} (${data.unit_z}) high`, 'low'],
      textStyle: { color: theme.mutedText },
      inRange: { color: [theme.primary, theme.warning] },
    },
    grid3D: {
      top: 22,
      bottom: 4,
      boxWidth: 130,
      boxHeight: 86,
      boxDepth: 94,
      axisLine: { lineStyle: { color: theme.axis } },
      axisPointer: { lineStyle: { color: theme.primary } },
      splitLine: { lineStyle: { color: theme.grid } },
      viewControl: {
        projection: 'perspective',
        alpha: 24,
        beta: 38,
        distance: 178,
        rotateSensitivity: 1,
        zoomSensitivity: 1.2,
        panSensitivity: 0.6,
      },
      light: {
        main: { intensity: theme.isLight ? 0.78 : 0.92, shadow: false },
        ambient: { intensity: theme.isLight ? 0.45 : 0.32 },
      },
    },
    xAxis3D: {
      type: 'value',
      // Fit the range to the actual data instead of always including zero
      // (e.g. values clustered at 200-250 would otherwise still show the
      // axis starting at 0).
      scale: true,
      name: `${labelX} (${data.unit_x})`,
      ...commonAxisStyle,
    },
    yAxis3D: {
      ...scaledValueAxis(yScale, undefined, { scaleToData: true }),
      name: `${labelY} (${data.unit_y})`,
      ...commonAxisStyle,
    },
    zAxis3D: {
      type: 'value',
      scale: true,
      name: `${labelZ} (${data.unit_z})`,
      ...commonAxisStyle,
    },
    series: [
      {
        type: 'scatter3D',
        data: data.data.map((point) => [point.x, point.y, point.z]),
        symbolSize: 5,
        itemStyle: { opacity: 0.82 },
        emphasis: { itemStyle: { opacity: 1 } },
      },
    ],
  };

  return (
    <div className="relative">
      <div className="absolute left-3 top-2 z-10 flex overflow-hidden rounded border border-gray-600 text-xs">
        <button type="button" onClick={() => applyView('standard')} className="px-2 py-1 bg-gray-700 text-gray-300 transition-colors hover:bg-gray-600 hover:text-white">
          Reset
        </button>
        <button type="button" onClick={() => applyView('top')} className="px-2 py-1 bg-gray-700 text-gray-300 transition-colors hover:bg-gray-600 hover:text-white">
          From above
        </button>
        <button type="button" onClick={() => applyView('front')} className="px-2 py-1 bg-gray-700 text-gray-300 transition-colors hover:bg-gray-600 hover:text-white">
          From the front
        </button>
        <button type="button" onClick={() => applyView('side')} className="px-2 py-1 bg-gray-700 text-gray-300 transition-colors hover:bg-gray-600 hover:text-white">
          From the side
        </button>
      </div>
      <div
        className="absolute right-3 top-2 z-10 rounded bg-black/30 px-2 py-1 text-xs"
        style={{ color: theme.mutedText }}
      >
        <span className="font-semibold" style={{ color: theme.text }}>{methodSymbol} = {data.correlation.toFixed(2)}</span>
        <span className="ml-1">({direction.toLowerCase()} X/Y correlation, {CORRELATION_METHOD_LABELS[method]})</span>
      </div>
      <ReactECharts
        ref={chartRef}
        echarts={echarts}
        option={option}
        style={{ height: 430 }}
        notMerge
        lazyUpdate
      />
    </div>
  );
}
