import {
  forwardRef,
  useMemo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from 'react';
import { use as registerEcharts, type ECharts, type EChartsCoreOption } from 'echarts/core';
import { ToolboxComponent } from 'echarts/components';

// Every chart offers its picture as PNG (see withExport); registered once for all charts.
registerEcharts([ToolboxComponent]);

type EChartsModule = {
  init: (
    dom: HTMLElement,
    theme?: string | object | null,
    opts?: object,
  ) => ECharts;
};

export interface ReactEChartsHandle {
  getEchartsInstance: () => ECharts | null;
}

interface Props {
  echarts: EChartsModule;
  option: EChartsCoreOption;
  notMerge?: boolean;
  lazyUpdate?: boolean;
  theme?: string | object;
  opts?: { renderer?: 'canvas' | 'svg'; width?: number | string; height?: number | string };
  style?: CSSProperties;
  className?: string;
  onEvents?: Record<string, (params: unknown) => void>;
  /** File name of the PNG download; false hides the download. Charts with their own toolbox keep it. */
  exportName?: string | false;
  /** Let unmodified wheel events scroll the page before ECharts' roam controller consumes them. */
  wheelZoomModifier?: 'ctrl';
}

/** The option with a PNG download in the corner, drawn on the page background so the picture stays readable. */
function withExport(option: EChartsCoreOption, exportName: string | false | undefined): EChartsCoreOption {
  if (exportName === false || (option as { toolbox?: unknown }).toolbox) return option;
  const background = typeof document === 'undefined' ? '#fff' : getComputedStyle(document.body).backgroundColor || '#fff';
  return {
    ...option,
    toolbox: {
      right: 0, top: 0, itemSize: 11,
      feature: { saveAsImage: { title: 'PNG', name: exportName ?? 'chart', pixelRatio: 2, backgroundColor: background } },
    },
  };
}

function ReactECharts(
  { echarts, option: given, notMerge = false, lazyUpdate = false, theme, opts, style, className, onEvents, exportName, wheelZoomModifier }: Props,
  ref: Ref<ReactEChartsHandle>,
) {
  const option = useMemo(() => withExport(given, exportName), [given, exportName]);
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<ECharts | null>(null);

  useImperativeHandle(
    ref,
    () => ({ getEchartsInstance: () => instanceRef.current }),
    [],
  );

  // The effect below applies option/notMerge/lazyUpdate/opts updates to the
  // existing instance without re-initializing it; read the latest values via
  // ref here so init/dispose isn't tied to their identity. Refreshed after
  // every render (not during render, which is unsafe for refs).
  const initPropsRef = useRef({ option, notMerge, lazyUpdate, opts });
  useEffect(() => {
    initPropsRef.current = { option, notMerge, lazyUpdate, opts };
  });

  // The instance as state as well, so the event bindings below follow it once it exists.
  const [instance, setInstance] = useState<ECharts | null>(null);

  // Init / dispose. Re-runs only when the echarts module or theme identity changes.
  // Each chart starts in a task of its own: a section whose charts mount together (the comparison has five, one of
  // them with a point per line and scenario) would otherwise block scrolling and input for all of them in one go.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let inst: ECharts | null = null;
    let ro: ResizeObserver | null = null;
    const timer = window.setTimeout(() => {
      const initial = initPropsRef.current;
      inst = echarts.init(container, theme ?? null, initial.opts);
      instanceRef.current = inst;
      inst.setOption(initial.option, { notMerge: initial.notMerge, lazyUpdate: initial.lazyUpdate });
      const current = inst;
      ro = new ResizeObserver(() => current.resize());
      ro.observe(container);
      setInstance(inst);
    }, 0);

    return () => {
      window.clearTimeout(timer);
      ro?.disconnect();
      inst?.dispose();
      instanceRef.current = null;
    };
  }, [echarts, theme]);

  // Apply option updates to the existing instance (until it exists, the init above takes the latest option).
  useEffect(() => {
    instanceRef.current?.setOption(option, { notMerge, lazyUpdate });
  }, [option, notMerge, lazyUpdate]);

  // Bind/unbind event handlers.
  useEffect(() => {
    if (!instance || instance.isDisposed() || !onEvents) return;
    const entries = Object.entries(onEvents);
    for (const [event, handler] of entries) instance.on(event, handler);
    return () => {
      if (instance.isDisposed()) return;
      for (const [event, handler] of entries) instance.off(event, handler);
    };
  }, [instance, onEvents]);

  return <div ref={containerRef} style={style} className={className}
    onWheelCapture={wheelZoomModifier ? (event) => { if (!event.ctrlKey) event.stopPropagation(); } : undefined} />;
}

export default forwardRef<ReactEChartsHandle, Props>(ReactECharts);
