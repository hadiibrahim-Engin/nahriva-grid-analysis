import type { TimeseriesData } from '../api/client';

export interface SeriesExportRow {
  facilityId: string;
  facilityName: string;
  componentId: string;
  componentName: string;
  measurementType: string;
  data: TimeseriesData;
}

function escapeField(value: string | number): string {
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function columnLabel(row: SeriesExportRow): string {
  return [
    `anlage=${row.facilityName}`,
    `anlage_id=${row.facilityId}`,
    `betriebsmittel=${row.componentName}`,
    `betriebsmittel_id=${row.componentId}`,
    `measurement_type=${row.measurementType}`,
    `unit=${row.data.unit}`,
  ].join(' | ');
}

export function buildTimeseriesCsv(rows: SeriesExportRow[]): string {
  // Wide time-series matrix: one row per timestamp, one value column per
  // selected series. The column label carries the metadata in this order:
  // Anlage | Anlage-ID | Betriebsmittel | Betriebsmittel-ID | Messgroesse | Einheit.
  const header = ['timestamp', ...rows.map(columnLabel)];
  const valuesByTimestamp = new Map<string, Array<number | ''>>();

  rows.forEach((row, columnIndex) => {
    row.data.data.forEach((point) => {
      const values = valuesByTimestamp.get(point.timestamp) ?? Array<number | ''>(rows.length).fill('');
      values[columnIndex] = point.value;
      valuesByTimestamp.set(point.timestamp, values);
    });
  });

  const lines: string[] = [header.map(escapeField).join(',')];
  Array.from(valuesByTimestamp.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([timestamp, values]) => {
      lines.push([
        escapeField(timestamp),
        ...values.map((value) => (value === '' ? '' : escapeField(value))),
      ].join(','));
    });

  return lines.join('\r\n');
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

export async function saveCsvToDisk(csv: string, suggestedName: string): Promise<void> {
  // BOM keeps Excel happy with UTF-8 (German umlauts in component names).
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const w = window as unknown as {
    showSaveFilePicker?: (opts: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  };
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(url);
}
