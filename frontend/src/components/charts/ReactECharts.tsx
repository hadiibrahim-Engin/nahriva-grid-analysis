import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type Ref,
} from 'react';
import type { ECharts, EChartsCoreOption } from 'echarts/core';

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
}

function ReactECharts(
  { echarts, option, notMerge = false, lazyUpdate = false, theme, opts, style, className, onEvents }: Props,
  ref: Ref<ReactEChartsHandle>,
) {
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

  // Init / dispose. Re-runs only when the echarts module or theme identity changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const initial = initPropsRef.current;
    const inst = echarts.init(container, theme ?? null, initial.opts);
    instanceRef.current = inst;
    inst.setOption(initial.option, { notMerge: initial.notMerge, lazyUpdate: initial.lazyUpdate });

    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(container);

    return () => {
      ro.disconnect();
      inst.dispose();
      instanceRef.current = null;
    };
  }, [echarts, theme]);

  // Apply option updates to the existing instance.
  useEffect(() => {
    instanceRef.current?.setOption(option, { notMerge, lazyUpdate });
  }, [option, notMerge, lazyUpdate]);

  // Bind/unbind event handlers.
  useEffect(() => {
    const inst = instanceRef.current;
    if (!inst || !onEvents) return;
    const entries = Object.entries(onEvents);
    for (const [event, handler] of entries) inst.on(event, handler);
    return () => {
      for (const [event, handler] of entries) inst.off(event, handler);
    };
  }, [onEvents]);

  return <div ref={containerRef} style={style} className={className} />;
}

export default forwardRef<ReactEChartsHandle, Props>(ReactECharts);
