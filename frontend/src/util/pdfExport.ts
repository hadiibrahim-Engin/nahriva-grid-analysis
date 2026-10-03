import { jsPDF } from 'jspdf';

export type PdfExportPhase = 'idle' | 'preparing' | 'rendering' | 'generating' | 'ready' | 'error';

export interface PdfExportProgress {
  phase: PdfExportPhase;
  progress: number;
  message: string;
}

export interface PdfMetadataEntry {
  label: string;
  value: string;
}

export interface PdfSummarySection {
  title: string;
  lines: string[];
}

export interface PdfSectionCapture {
  title: string;
  element: HTMLElement;
}

export interface PdfPoint {
  x: number;
  y: number;
}

export interface PdfSeries {
  name: string;
  points: PdfPoint[];
  color?: string;
}

export type PdfChartSpec =
  | {
      kind: 'line';
      title: string;
      subtitle?: string;
      xType?: 'time' | 'number';
      xLabel?: string;
      yLabel?: string;
      series: PdfSeries[];
    }
  | {
      kind: 'bar';
      title: string;
      subtitle?: string;
      xLabel?: string;
      yLabel?: string;
      categories: string[];
      values: number[];
      color?: string;
    }
  | {
      kind: 'scatter';
      title: string;
      subtitle?: string;
      xLabel?: string;
      yLabel?: string;
      points: PdfPoint[];
      color?: string;
    }
  | {
      kind: 'heatmap';
      title: string;
      subtitle?: string;
      xLabel?: string;
      yLabel?: string;
      xLabels: string[];
      yLabels: string[];
      cells: Array<{ x: number; y: number; value: number }>;
      lowLabel?: string;
      highLabel?: string;
    }
  | {
      kind: 'table';
      title: string;
      subtitle?: string;
      columns: string[];
      rows: Array<{ label: string; values: string[] }>;
    };

export type PdfSaveTarget =
  | { type: 'file-system'; handle: FileSystemFileHandle }
  | { type: 'download' };

export interface PdfExportRequest {
  title: string;
  filename: string;
  exportedObjectLabel: string;
  exportTimestamp: Date;
  metadata: PdfMetadataEntry[];
  summarySections: PdfSummarySection[];
  signals: string[];
  sections: PdfSectionCapture[];
  charts?: PdfChartSpec[];
  mapSnapshot?: HTMLElement | null;
  saveTarget?: PdfSaveTarget;
  onProgress?: (progress: PdfExportProgress) => void;
}

interface FileSystemWritableFileStream {
  write(data: BlobPart): Promise<void>;
  close(): Promise<void>;
}

interface FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}

type Rgb = [number, number, number];

const REPORT = {
  page: [248, 250, 252] as Rgb,
  card: [255, 255, 255] as Rgb,
  soft: [236, 241, 247] as Rgb,
  ink: [15, 23, 42] as Rgb,
  muted: [92, 106, 125] as Rgb,
  faint: [137, 151, 169] as Rgb,
  border: [203, 213, 225] as Rgb,
  navy: [255, 255, 255] as Rgb,
  navy2: [241, 245, 249] as Rgb,
  accent: [37, 99, 235] as Rgb,
  cyan: [8, 145, 178] as Rgb,
  green: [22, 163, 74] as Rgb,
  amber: [217, 119, 6] as Rgb,
};

const PLOT = {
  bg: [255, 255, 255] as Rgb,
  grid: [226, 232, 240] as Rgb,
  axis: [100, 116, 139] as Rgb,
  text: [15, 23, 42] as Rgb,
  muted: [71, 85, 105] as Rgb,
  colors: ['#1d4ed8', '#0f766e', '#b45309', '#b91c1c', '#7c3aed', '#0369a1', '#be123c'],
};

function emitProgress(onProgress: PdfExportRequest['onProgress'], phase: PdfExportPhase, progress: number, message: string) {
  onProgress?.({ phase, progress, message });
}

function formatStamp(date: Date): string {
  return date.toLocaleString('de-DE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function splitLines(doc: jsPDF, text: string, maxWidth: number): string[] {
  return doc.splitTextToSize(text, maxWidth) as string[];
}

function setFill(doc: jsPDF, color: Rgb) {
  doc.setFillColor(color[0], color[1], color[2]);
}

function setDraw(doc: jsPDF, color: Rgb) {
  doc.setDrawColor(color[0], color[1], color[2]);
}

function setText(doc: jsPDF, color: Rgb) {
  doc.setTextColor(color[0], color[1], color[2]);
}

function hexToRgb(hex: string): Rgb {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function finite(values: number[]): number[] {
  return values.filter((value) => Number.isFinite(value));
}

function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function expandDomain(min: number, max: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.08, 1);
    return [min - pad, max + pad];
  }
  const pad = (max - min) * 0.08;
  return [min - pad, max + pad];
}

function fillPage(doc: jsPDF) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  setFill(doc, REPORT.page);
  doc.rect(0, 0, pageWidth, pageHeight, 'F');
}

function drawFooter(doc: jsPDF, pageNumber: number, pageCount: number, exportedObjectLabel: string, exportTimestamp: Date) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const footerY = pageHeight - 8;

  setDraw(doc, [220, 228, 238]);
  doc.line(14, footerY - 5, pageWidth - 14, footerY - 5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  setText(doc, REPORT.faint);
  doc.text(`${formatStamp(exportTimestamp)} | ${exportedObjectLabel}`, 14, footerY);
  doc.text(`Seite ${pageNumber} / ${pageCount}`, pageWidth - 14, footerY, { align: 'right' });
}

function drawCard(doc: jsPDF, x: number, y: number, width: number, height: number, fill: Rgb = REPORT.card) {
  setFill(doc, fill);
  setDraw(doc, REPORT.border);
  doc.roundedRect(x, y, width, height, 3, 3, 'FD');
}

function drawSmallLabel(doc: jsPDF, label: string, x: number, y: number, color: Rgb = REPORT.muted) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.2);
  setText(doc, color);
  doc.text(label.toUpperCase(), x, y);
}

function drawMetricCard(doc: jsPDF, label: string, value: string, x: number, y: number, width: number, accent: Rgb) {
  drawCard(doc, x, y, width, 28);
  setFill(doc, accent);
  doc.roundedRect(x, y, 3, 28, 3, 3, 'F');
  doc.rect(x + 1.5, y, 1.5, 28, 'F');

  drawSmallLabel(doc, label, x + 7, y + 8);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  setText(doc, REPORT.ink);
  doc.text(splitLines(doc, value, width - 11).slice(0, 2), x + 7, y + 17);
}

function drawPageTitle(doc: jsPDF, eyebrow: string, title: string, subtitle?: string) {
  const pageWidth = doc.internal.pageSize.getWidth();
  setFill(doc, REPORT.card);
  doc.rect(0, 0, pageWidth, 31, 'F');
  setFill(doc, REPORT.accent);
  doc.rect(0, 30, pageWidth, 1, 'F');
  doc.rect(0, 0, 5, 31, 'F');

  drawSmallLabel(doc, eyebrow, 14, 12, REPORT.accent);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  setText(doc, REPORT.ink);
  doc.text(splitLines(doc, title, pageWidth - 58).slice(0, 1), 14, 22);

  if (subtitle) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    setText(doc, REPORT.muted);
    doc.text(splitLines(doc, subtitle, 102).slice(0, 1), pageWidth - 14, 22, { align: 'right' });
  }
}

function drawTableCard(
  doc: jsPDF,
  title: string,
  rows: Array<{ label: string; value: string }>,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  drawCard(doc, x, y, width, height);
  drawSmallLabel(doc, title, x + 5, y + 8);
  setDraw(doc, REPORT.border);
  doc.line(x + 5, y + 11, x + width - 5, y + 11);

  const labelWidth = Math.max(34, Math.min(48, width * 0.34));
  let cursorY = y + 18;
  rows.forEach((row) => {
    if (cursorY > y + height - 5) return;
    const valueLines = splitLines(doc, row.value, width - labelWidth - 14).slice(0, 2);
    const rowHeight = Math.max(6, valueLines.length * 3.8 + 1.5);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    setText(doc, REPORT.muted);
    doc.text(splitLines(doc, row.label, labelWidth - 3).slice(0, 1), x + 5, cursorY);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    setText(doc, REPORT.ink);
    doc.text(valueLines, x + labelWidth + 7, cursorY);

    cursorY += rowHeight;
  });
}

function drawListCard(doc: jsPDF, title: string, lines: string[], x: number, y: number, width: number, height: number) {
  drawCard(doc, x, y, width, height);
  drawSmallLabel(doc, title, x + 5, y + 8);
  setDraw(doc, REPORT.border);
  doc.line(x + 5, y + 11, x + width - 5, y + 11);

  let cursorY = y + 18;
  lines.forEach((line) => {
    if (cursorY > y + height - 6) return;
    setFill(doc, REPORT.accent);
    doc.circle(x + 6, cursorY - 1.5, 0.8, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    setText(doc, REPORT.ink);
    const textLines = splitLines(doc, line, width - 16).slice(0, 2);
    doc.text(textLines, x + 10, cursorY);
    cursorY += Math.max(5.5, textLines.length * 3.8 + 1.5);
  });
}

function metadataValue(request: PdfExportRequest, label: string): string {
  return request.metadata.find((entry) => entry.label === label)?.value ?? 'n/a';
}

function renderCoverPage(doc: jsPDF, request: PdfExportRequest) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  fillPage(doc);

  setFill(doc, REPORT.card);
  doc.rect(0, 0, pageWidth, 62, 'F');
  setFill(doc, REPORT.soft);
  doc.rect(pageWidth - 88, 0, 88, 62, 'F');
  setFill(doc, REPORT.accent);
  doc.rect(0, 0, 6, pageHeight, 'F');
  setFill(doc, REPORT.cyan);
  doc.rect(6, 58, pageWidth - 6, 4, 'F');

  drawSmallLabel(doc, 'PowerFactory Simulation Analysis', 16, 18, REPORT.accent);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  setText(doc, REPORT.ink);
  doc.text(splitLines(doc, request.title, 166).slice(0, 2), 16, 33);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  setText(doc, REPORT.muted);
  doc.text(splitLines(doc, request.exportedObjectLabel, 150).slice(0, 1), 16, 54);

  drawSmallLabel(doc, 'Generated', pageWidth - 72, 20, REPORT.accent);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  setText(doc, REPORT.ink);
  doc.text(formatStamp(request.exportTimestamp), pageWidth - 72, 31);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  setText(doc, REPORT.muted);
  doc.text(`${request.charts?.length ?? 0} light PDF plots`, pageWidth - 72, 42);

  const kpiY = 75;
  const kpiW = (pageWidth - 32 - 18) / 4;
  drawMetricCard(doc, 'Station / Facility', metadataValue(request, 'Station / Facility'), 16, kpiY, kpiW, REPORT.accent);
  drawMetricCard(doc, 'Anlagennummer', metadataValue(request, 'Anlagennummer'), 16 + kpiW + 6, kpiY, kpiW, REPORT.cyan);
  drawMetricCard(doc, 'Time range', metadataValue(request, 'Time range'), 16 + (kpiW + 6) * 2, kpiY, kpiW, REPORT.green);
  drawMetricCard(doc, 'Signals', metadataValue(request, 'Exported signals'), 16 + (kpiW + 6) * 3, kpiY, kpiW, REPORT.amber);

  drawTableCard(doc, 'Selection', request.metadata, 16, 117, pageWidth - 32, 66);
}

function renderOverviewPage(doc: jsPDF, request: PdfExportRequest, pageCountRef: { value: number }) {
  doc.addPage();
  pageCountRef.value += 1;
  fillPage(doc);
  drawPageTitle(doc, 'Report overview', 'Context, signals, and native plot inventory', request.exportedObjectLabel);

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 14;
  const gap = 7;
  const leftW = 122;
  const rightX = marginX + leftW + gap;
  const rightW = pageWidth - rightX - marginX;
  const summaryTop = 43;
  const cardH = 35;

  request.summarySections.slice(0, 4).forEach((section, index) => {
    const x = index % 2 === 0 ? marginX : marginX + ((leftW - gap) / 2) + gap;
    const y = summaryTop + Math.floor(index / 2) * (cardH + 7);
    drawListCard(doc, section.title, section.lines, x, y, (leftW - gap) / 2, cardH);
  });

  drawCard(doc, rightX, summaryTop, rightW, 77);
  drawSmallLabel(doc, 'Exported signals', rightX + 5, summaryTop + 8);
  setDraw(doc, REPORT.border);
  doc.line(rightX + 5, summaryTop + 11, rightX + rightW - 5, summaryTop + 11);

  const signalLines = request.signals.length > 0 ? request.signals : ['Keine Zeitreihen ausgewählt.'];
  const maxRowsPerColumn = 11;
  const columnGap = 7;
  const columnW = (rightW - 10 - columnGap) / 2;
  signalLines.slice(0, maxRowsPerColumn * 2).forEach((signal, index) => {
    const column = index >= maxRowsPerColumn ? 1 : 0;
    const row = index % maxRowsPerColumn;
    const x = rightX + 5 + column * (columnW + columnGap);
    const y = summaryTop + 19 + row * 5;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    setText(doc, REPORT.accent);
    doc.text(String(index + 1).padStart(2, '0'), x, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.2);
    setText(doc, REPORT.ink);
    doc.text(splitLines(doc, signal, columnW - 11).slice(0, 1), x + 10, y);
  });

  if (signalLines.length > maxRowsPerColumn * 2) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    setText(doc, REPORT.muted);
    doc.text(`+ ${signalLines.length - (maxRowsPerColumn * 2)} more`, rightX + 5, summaryTop + 73);
  }

  drawCard(doc, marginX, 129, pageWidth - (marginX * 2), 39, REPORT.card);
  drawSmallLabel(doc, 'Light PDF plot structure', marginX + 5, 137);
  const structure = [
    'Only Zeitreihen, Muster, and optional Korrelation are included in this export.',
    'Plots are drawn with PDF primitives on a light plotting surface; screenshots and dashboard chrome are excluded.',
    'Correlation is included only when two selected signals have correlation data available.',
  ];
  structure.forEach((line, index) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.4);
    setText(doc, REPORT.ink);
    doc.text(line, marginX + 7, 148 + index * 7);
  });

  setText(doc, REPORT.faint);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.2);
  doc.text('The PDF renderer uses chart data, not visual captures, for the analysis plots.', marginX, pageHeight - 20);
}

interface PlotArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

function drawPlotShell(doc: jsPDF, area: PlotArea, xLabel?: string, yLabel?: string) {
  setFill(doc, PLOT.bg);
  setDraw(doc, REPORT.border);
  doc.roundedRect(area.x, area.y, area.width, area.height, 3, 3, 'FD');

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  setText(doc, PLOT.muted);
  if (xLabel) doc.text(xLabel, area.x + area.width / 2, area.y + area.height - 6, { align: 'center' });
  if (yLabel) doc.text(yLabel, area.x + 7, area.y + 10);
}

function drawLegend(doc: jsPDF, series: Array<{ name: string; color: string }>, x: number, y: number, maxWidth: number) {
  let cursorX = x;
  let cursorY = y;
  series.slice(0, 7).forEach((item) => {
    const labelWidth = Math.min(38, doc.getTextWidth(item.name) + 8);
    if (cursorX + labelWidth > x + maxWidth) {
      cursorX = x;
      cursorY += 6;
    }
    setFill(doc, hexToRgb(item.color));
    doc.circle(cursorX + 1.5, cursorY - 1.5, 1.2, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    setText(doc, PLOT.muted);
    doc.text(splitLines(doc, item.name, labelWidth - 5).slice(0, 1), cursorX + 5, cursorY);
    cursorX += labelWidth + 3;
  });
}

function drawAxes(doc: jsPDF, plot: PlotArea, xTicks: Array<{ value: number; label: string }>, yMin: number, yMax: number) {
  setDraw(doc, PLOT.grid);
  doc.setLineWidth(0.2);
  for (let i = 0; i <= 4; i += 1) {
    const y = plot.y + plot.height - (plot.height * i / 4);
    doc.line(plot.x, y, plot.x + plot.width, y);
    const value = yMin + ((yMax - yMin) * i / 4);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    setText(doc, PLOT.axis);
    doc.text(formatNumber(value), plot.x - 3, y + 2, { align: 'right' });
  }

  setDraw(doc, PLOT.axis);
  doc.line(plot.x, plot.y + plot.height, plot.x + plot.width, plot.y + plot.height);
  doc.line(plot.x, plot.y, plot.x, plot.y + plot.height);

  xTicks.forEach((tick) => {
    const x = plot.x + tick.value * plot.width;
    setDraw(doc, PLOT.grid);
    doc.line(x, plot.y, x, plot.y + plot.height);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.7);
    setText(doc, PLOT.axis);
    doc.text(tick.label, x, plot.y + plot.height + 5, { align: 'center' });
  });
}

function sampled(points: PdfPoint[], limit = 900): PdfPoint[] {
  if (points.length <= limit) return points;
  const step = Math.ceil(points.length / limit);
  return points.filter((_, index) => index % step === 0);
}

function drawLineChart(doc: jsPDF, spec: Extract<PdfChartSpec, { kind: 'line' }>, area: PlotArea) {
  drawPlotShell(doc, area, spec.xLabel, spec.yLabel);
  const plot: PlotArea = { x: area.x + 29, y: area.y + 23, width: area.width - 40, height: area.height - 48 };
  const allPoints = spec.series.flatMap((series) => series.points).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const xValues = allPoints.map((point) => point.x);
  const yValues = allPoints.map((point) => point.y);
  const [xMin, xMax] = expandDomain(Math.min(...xValues), Math.max(...xValues));
  const [yMin, yMax] = expandDomain(Math.min(...yValues), Math.max(...yValues));
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const raw = xMin + ((xMax - xMin) * ratio);
    return { value: ratio, label: spec.xType === 'time' ? formatTime(raw) : formatNumber(raw) };
  });

  drawAxes(doc, plot, xTicks, yMin, yMax);
  drawLegend(
    doc,
    spec.series.map((series, index) => ({ name: series.name, color: series.color ?? PLOT.colors[index % PLOT.colors.length] })),
    area.x + 9,
    area.y + 13,
    area.width - 18,
  );

  spec.series.forEach((series, index) => {
    const color = hexToRgb(series.color ?? PLOT.colors[index % PLOT.colors.length]);
    const points = sampled(series.points)
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      .map((point) => ({
        x: plot.x + ((point.x - xMin) / (xMax - xMin)) * plot.width,
        y: plot.y + plot.height - ((point.y - yMin) / (yMax - yMin)) * plot.height,
      }));

    setDraw(doc, color);
    doc.setLineWidth(0.55);
    for (let i = 1; i < points.length; i += 1) {
      doc.line(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y);
    }
  });
  doc.setLineWidth(0.2);
}

function drawBarChart(doc: jsPDF, spec: Extract<PdfChartSpec, { kind: 'bar' }>, area: PlotArea) {
  drawPlotShell(doc, area, spec.xLabel, spec.yLabel);
  const plot: PlotArea = { x: area.x + 29, y: area.y + 18, width: area.width - 40, height: area.height - 43 };
  const values = finite(spec.values);
  const yMax = Math.max(...values, 1) * 1.12;
  drawAxes(doc, plot, [], 0, yMax);

  const count = Math.min(spec.values.length, 34);
  const barGap = 1.2;
  const barW = Math.max(1.2, (plot.width - (count - 1) * barGap) / count);
  const color = hexToRgb(spec.color ?? PLOT.colors[0]);
  for (let i = 0; i < count; i += 1) {
    const value = spec.values[i];
    const barH = Math.max(0, (value / yMax) * plot.height);
    const x = plot.x + i * (barW + barGap);
    const y = plot.y + plot.height - barH;
    setFill(doc, color);
    doc.roundedRect(x, y, barW, barH, 0.8, 0.8, 'F');
    if (i % Math.ceil(count / 8) === 0) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.4);
      setText(doc, PLOT.axis);
      doc.text(splitLines(doc, spec.categories[i] ?? '', 18).slice(0, 1), x + barW / 2, plot.y + plot.height + 5, { align: 'center' });
    }
  }
}

function drawScatterChart(doc: jsPDF, spec: Extract<PdfChartSpec, { kind: 'scatter' }>, area: PlotArea) {
  drawPlotShell(doc, area, spec.xLabel, spec.yLabel);
  const plot: PlotArea = { x: area.x + 29, y: area.y + 18, width: area.width - 40, height: area.height - 43 };
  const points = sampled(spec.points, 1200).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const [xMin, xMax] = expandDomain(Math.min(...points.map((point) => point.x)), Math.max(...points.map((point) => point.x)));
  const [yMin, yMax] = expandDomain(Math.min(...points.map((point) => point.y)), Math.max(...points.map((point) => point.y)));
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const raw = xMin + ((xMax - xMin) * ratio);
    return { value: ratio, label: formatNumber(raw) };
  });
  drawAxes(doc, plot, xTicks, yMin, yMax);

  setFill(doc, hexToRgb(spec.color ?? PLOT.colors[1]));
  points.forEach((point) => {
    const x = plot.x + ((point.x - xMin) / (xMax - xMin)) * plot.width;
    const y = plot.y + plot.height - ((point.y - yMin) / (yMax - yMin)) * plot.height;
    doc.circle(x, y, 0.55, 'F');
  });
}

function interpolate(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function drawHeatmapChart(doc: jsPDF, spec: Extract<PdfChartSpec, { kind: 'heatmap' }>, area: PlotArea) {
  drawPlotShell(doc, area, spec.xLabel, spec.yLabel);
  const plot: PlotArea = { x: area.x + 27, y: area.y + 18, width: area.width - 42, height: area.height - 40 };
  const values = finite(spec.cells.map((cell) => cell.value));
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const cellW = plot.width / Math.max(spec.xLabels.length, 1);
  const cellH = plot.height / Math.max(spec.yLabels.length, 1);

  spec.cells.forEach((cell) => {
    const t = max === min ? 0.5 : Math.max(0, Math.min(1, (cell.value - min) / (max - min)));
    const color = t < 0.5
      ? interpolate([219, 234, 254], [37, 99, 235], t * 2)
      : interpolate([37, 99, 235], [217, 119, 6], (t - 0.5) * 2);
    setFill(doc, color);
    setDraw(doc, PLOT.bg);
    doc.rect(plot.x + cell.x * cellW, plot.y + cell.y * cellH, cellW, cellH, 'FD');
  });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  setText(doc, PLOT.axis);
  spec.xLabels.forEach((label, index) => {
    if (index % Math.ceil(spec.xLabels.length / 8) === 0) {
      doc.text(label, plot.x + index * cellW + cellW / 2, plot.y + plot.height + 5, { align: 'center' });
    }
  });
  spec.yLabels.forEach((label, index) => {
    doc.text(label, plot.x - 3, plot.y + index * cellH + cellH / 2 + 1.5, { align: 'right' });
  });

  setText(doc, PLOT.muted);
  doc.text(`${spec.lowLabel ?? 'Low'}: ${formatNumber(min)}   ${spec.highLabel ?? 'High'}: ${formatNumber(max)}`, plot.x, area.y + area.height - 8);
}

function drawTableChart(doc: jsPDF, spec: Extract<PdfChartSpec, { kind: 'table' }>, area: PlotArea) {
  drawPlotShell(doc, area);
  const x = area.x + 9;
  let y = area.y + 18;
  const width = area.width - 18;
  const labelW = width * 0.35;
  const valueW = (width - labelW) / Math.max(spec.columns.length, 1);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.3);
  setText(doc, PLOT.muted);
  spec.columns.forEach((column, index) => {
    doc.text(column, x + labelW + index * valueW, y);
  });
  y += 5;
  setDraw(doc, PLOT.grid);
  doc.line(x, y - 2, x + width, y - 2);

  spec.rows.slice(0, 18).forEach((row, rowIndex) => {
    if (rowIndex % 2 === 0) {
      setFill(doc, [241, 245, 249]);
      doc.rect(x - 2, y - 3.5, width + 4, 5.7, 'F');
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.2);
    setText(doc, PLOT.text);
    doc.text(splitLines(doc, row.label, labelW - 4).slice(0, 1), x, y);
    doc.setFont('helvetica', 'normal');
    setText(doc, PLOT.muted);
    row.values.forEach((value, index) => {
      doc.text(splitLines(doc, value, valueW - 3).slice(0, 1), x + labelW + index * valueW, y);
    });
    y += 6;
  });
}

function drawChartBody(doc: jsPDF, spec: PdfChartSpec, area: PlotArea) {
  if (spec.kind === 'line') drawLineChart(doc, spec, area);
  if (spec.kind === 'bar') drawBarChart(doc, spec, area);
  if (spec.kind === 'scatter') drawScatterChart(doc, spec, area);
  if (spec.kind === 'heatmap') drawHeatmapChart(doc, spec, area);
  if (spec.kind === 'table') drawTableChart(doc, spec, area);
}

function addNativeChartPage(doc: jsPDF, pageCountRef: { value: number }, spec: PdfChartSpec, chartIndex: number) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 14;
  const panelY = 44;
  const panelW = pageWidth - (marginX * 2);
  const panelH = pageHeight - panelY - 26;

  doc.addPage();
  pageCountRef.value += 1;
  fillPage(doc);
  drawPageTitle(doc, `Plot ${String(chartIndex + 1).padStart(2, '0')}`, spec.title, spec.subtitle);
  drawCard(doc, marginX, panelY, panelW, panelH, REPORT.card);
  drawChartBody(doc, spec, { x: marginX + 7, y: panelY + 7, width: panelW - 14, height: panelH - 14 });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  setText(doc, REPORT.muted);
  doc.text('Light native PDF plot: generated from chart data, not a dashboard screenshot.', marginX, pageHeight - 17);
}

export async function requestPdfSaveTarget(suggestedName: string): Promise<PdfSaveTarget | null> {
  const w = window as unknown as {
    showSaveFilePicker?: (opts: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  };
  const confirmBrowserDownload = () => window.confirm(
    'Your browser cannot show a folder picker for this PDF export. Download the report using the browser download folder instead?',
  );

  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      });
      return { type: 'file-system', handle };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return null;
      console.warn('PDF save picker unavailable, falling back to browser download', err);
      return confirmBrowserDownload() ? { type: 'download' } : null;
    }
  }

  return confirmBrowserDownload() ? { type: 'download' } : null;
}

async function savePdfToDisk(pdf: jsPDF, suggestedName: string, saveTarget?: PdfSaveTarget): Promise<void> {
  const blob = pdf.output('blob') as Blob;
  if (saveTarget?.type === 'file-system') {
    const writable = await saveTarget.handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function exportDashboardPdf(request: PdfExportRequest): Promise<void> {
  emitProgress(request.onProgress, 'preparing', 5, 'Preparing report');

  const charts = request.charts ?? [];
  if (charts.length === 0) {
    throw new Error('Keine nativen Diagrammdaten fuer den PDF-Report vorhanden.');
  }

  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
  const pageCountRef = { value: 1 };

  renderCoverPage(pdf, request);
  renderOverviewPage(pdf, request, pageCountRef);

  emitProgress(request.onProgress, 'rendering', 35, 'Drawing light PDF plots');

  charts.forEach((chart, index) => {
    emitProgress(
      request.onProgress,
      'rendering',
      35 + Math.round((index / Math.max(charts.length, 1)) * 45),
      `Drawing ${chart.title}`,
    );
    addNativeChartPage(pdf, pageCountRef, chart, index);
  });

  emitProgress(request.onProgress, 'generating', 92, 'Building PDF');

  const totalPages = pdf.getNumberOfPages();
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    pdf.setPage(pageNumber);
    drawFooter(pdf, pageNumber, totalPages, request.exportedObjectLabel, request.exportTimestamp);
  }

  await savePdfToDisk(pdf, request.filename, request.saveTarget);
  emitProgress(request.onProgress, 'ready', 100, 'PDF ready');
}
