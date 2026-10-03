import type { ECharts } from 'echarts/core';

export interface ChartExportImage {
  dataUrl: string;
  width: number;
  height: number;
}

const chartInstances = new WeakMap<HTMLElement, ECharts>();

export function registerChartExportRoot(root: HTMLElement, instance: ECharts) {
  root.dataset.chartExportRoot = 'true';
  chartInstances.set(root, instance);
}

export function unregisterChartExportRoot(root: HTMLElement) {
  chartInstances.delete(root);
  delete root.dataset.chartExportRoot;
}

export function getChartExportImages(root: HTMLElement, backgroundColor: string): ChartExportImage[] {
  const roots = [
    ...(root.dataset.chartExportRoot === 'true' ? [root] : []),
    ...Array.from(root.querySelectorAll<HTMLElement>('[data-chart-export-root="true"]')),
  ];

  return roots.flatMap((chartRoot) => {
    const instance = chartInstances.get(chartRoot);
    if (!instance || instance.isDisposed()) return [];

    try {
      const width = Math.max(instance.getWidth(), Math.ceil(chartRoot.getBoundingClientRect().width), 1);
      const height = Math.max(instance.getHeight(), Math.ceil(chartRoot.getBoundingClientRect().height), 1);
      return [{
        dataUrl: instance.getDataURL({
          type: 'png',
          pixelRatio: 2,
          backgroundColor,
        }),
        width,
        height,
      }];
    } catch (error) {
      console.warn('Chart export image generation failed', error);
      return [];
    }
  });
}
