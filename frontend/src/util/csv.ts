/** CSV and JSON downloads of what a table or chart shows. Values are written as they are; null stays empty. */

type Cell = string | number | boolean | null | undefined;

const quote = (value: Cell): string => {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** RFC 4180 CSV with a byte-order mark, so spreadsheet programs read UTF-8 names correctly. */
export function toCsv(header: readonly string[], rows: readonly (readonly Cell[])[]): string {
  return '﻿' + [header, ...rows].map((row) => row.map(quote).join(',')).join('\r\n') + '\r\n';
}

/** Hand a text file to the browser's download. */
export function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A file name fragment without characters a file system or browser might refuse. */
export const fileSafe = (text: string): string => text.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'export';
