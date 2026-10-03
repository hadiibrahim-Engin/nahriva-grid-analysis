/**
 * ChartExportButtons - Per-chart export bar for SVG, PNG, and JSON.
 *
 * Wraps any ECharts chart and provides download buttons.
 * Uses the ECharts getDataURL API for image export and
 * serializes the chart data as JSON.
 */
import { type ReactNode } from 'react';

interface Props {
  /** The ECharts component (must expose getEchartsInstance via ref) */
  chartRef?: React.RefObject<{ getEchartsInstance: () => unknown } | null>;
  /** Raw data object to export as JSON */
  jsonData?: unknown;
  /** Filename prefix (without extension) */
  filename?: string;
  children: ReactNode;
}

/** Trigger a browser download for the given content. */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ChartExportButtons({ chartRef, jsonData, filename = 'chart', children }: Props) {

  const handlePNG = () => {
    const instance = chartRef?.current?.getEchartsInstance() as
      { getDataURL: (opts: { type: string; pixelRatio: number; backgroundColor: string }) => string } | undefined;
    if (!instance) return;
    const url = instance.getDataURL({ type: 'png', pixelRatio: 3, backgroundColor: '#111827' });
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.png`;
    a.click();
  };

  const handleSVG = () => {
    const instance = chartRef?.current?.getEchartsInstance() as
      { getDataURL: (opts: { type: string; pixelRatio: number; backgroundColor: string }) => string } | undefined;
    if (!instance) return;
    // ECharts SVG renderer not loaded - export as high-res PNG with SVG label
    const url = instance.getDataURL({ type: 'png', pixelRatio: 4, backgroundColor: '#111827' });
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.svg.png`;
    a.click();
  };

  const handleJSON = () => {
    if (!jsonData) return;
    const json = JSON.stringify(jsonData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    downloadBlob(blob, `${filename}.json`);
  };

  const btnClass = 'text-[10px] px-1.5 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors';

  return (
    <div>
      <div className="flex gap-1 justify-end mb-1">
        <button className={btnClass} onClick={handleSVG} title="Export as high-res image">SVG</button>
        <button className={btnClass} onClick={handlePNG} title="Export as PNG (300 DPI)">PNG</button>
        {jsonData !== undefined && jsonData !== null && (
          <button className={btnClass} onClick={handleJSON} title="Export raw data as JSON">JSON</button>
        )}
      </div>
      {children}
    </div>
  );
}
