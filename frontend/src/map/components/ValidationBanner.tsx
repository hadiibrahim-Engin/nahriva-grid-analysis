/**
 * ValidationBanner — top-of-map dismissible warning strip.
 *
 * Shown when the validation report contains skipped assets or warnings.
 * Provides:
 *   • Summary count (N assets skipped, M warnings)
 *   • "Details" button → opens ValidationPanel
 *   • "Download Report" button → downloads report JSON
 *   • Dismiss (×) button — hides the banner for the session
 *
 * Severity colouring:
 *   • assetBlocking > 0  → amber/orange  (assets hidden)
 *   • warnings only      → yellow        (visible but degraded)
 */
import React, { useState, useCallback } from 'react';
import type { ValidationReport } from '../types';

interface Props {
  report: ValidationReport;
  /** Called when the "Details" button is clicked. */
  onShowDetails: () => void;
}

function downloadReport(report: ValidationReport) {
  const json = JSON.stringify(report, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `grid-validation-report-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function ValidationBanner({ report, onShowDetails }: Props) {
  const [dismissed, setDismissed] = useState(false);
  // Hooks must run unconditionally, so keep this above the early return below.
  const handleDownload = useCallback(() => downloadReport(report), [report]);

  const { summary, skippedAssets } = report;
  const totalSkipped  = skippedAssets?.length ?? 0;
  const totalWarnings = summary.warnings + summary.assetBlocking;

  // Don't render if nothing to report or already dismissed
  if (dismissed || (totalSkipped === 0 && totalWarnings === 0)) return null;

  const isAmber  = totalSkipped > 0 || summary.assetBlocking > 0;
  const bgColor  = isAmber ? 'rgba(244,162,97,0.18)' : 'rgba(255,214,0,0.14)';
  const border   = isAmber ? '1px solid rgba(244,162,97,0.55)' : '1px solid rgba(255,214,0,0.45)';
  const iconChar = isAmber ? '⚠' : 'ℹ';
  const iconClr  = isAmber ? '#F4A261' : '#FFD600';

  const parts: string[] = [];
  if (totalSkipped > 0) {
    parts.push(`${totalSkipped} ${totalSkipped === 1 ? 'Asset' : 'Assets'} ausgeblendet`);
  }
  if (summary.warnings > 0) {
    parts.push(`${summary.warnings} ${summary.warnings === 1 ? 'Warnung' : 'Warnungen'}`);
  }
  const summaryText = parts.join(' · ');

  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        position:       'absolute',
        top:            8,
        left:           '50%',
        transform:      'translateX(-50%)',
        zIndex:         500,
        display:        'flex',
        alignItems:     'center',
        gap:            8,
        background:     bgColor,
        border,
        borderRadius:   6,
        padding:        '5px 10px',
        fontSize:       12,
        color:          'var(--grid-text, #e0e0e0)',
        backdropFilter: 'blur(4px)',
        maxWidth:       'calc(100% - 32px)',
        boxShadow:      '0 2px 8px rgba(0,0,0,0.25)',
        userSelect:     'none',
        whiteSpace:     'nowrap',
      }}
    >
      {/* Icon */}
      <span style={{ color: iconClr, fontSize: 14, flexShrink: 0 }}>
        {iconChar}
      </span>

      {/* Summary text */}
      <span style={{ opacity: 0.9, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {summaryText}
      </span>

      {/* Details button */}
      <button
        onClick={onShowDetails}
        style={btnStyle}
        aria-label="Validierungsdetails anzeigen"
      >
        Details
      </button>

      {/* Download button */}
      <button
        onClick={handleDownload}
        style={btnStyle}
        aria-label="Validierungsbericht herunterladen"
        title="Validierungsbericht herunterladen"
      >
        ↓ JSON
      </button>

      {/* Dismiss */}
      <button
        onClick={() => setDismissed(true)}
        style={{ ...btnStyle, padding: '2px 6px', opacity: 0.6 }}
        aria-label="Bannermeldung schließen"
      >
        ✕
      </button>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background:   'rgba(255,255,255,0.1)',
  border:       '1px solid rgba(255,255,255,0.2)',
  borderRadius: 4,
  color:        'inherit',
  cursor:       'pointer',
  fontSize:     11,
  padding:      '2px 7px',
  flexShrink:   0,
};
