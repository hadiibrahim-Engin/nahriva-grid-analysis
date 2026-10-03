/**
 * ValidationPanel — sliding side-panel showing full validation report detail.
 *
 * Opened by the ValidationBanner's "Details" button or via the map's
 * debug/inspect menu. Displays:
 *
 *   • Summary counts (fatal / layer-blocking / asset-blocking / warnings)
 *   • Filterable issue table (by severity)
 *   • Skipped assets list with entity type + reason
 *   • Download button
 *
 * Absolutely positioned over the map container. Slides in from the right.
 * z-index 450 — above map controls but below modals.
 */
import React, { useState, useMemo } from 'react';
import type { ValidationReport, ValidationIssue, ValidationSeverity } from '../types';

interface Props {
  report: ValidationReport;
  onClose: () => void;
}

// -- Severity meta ---------------------------------------------------------

const SEVERITY_META: Record<
  ValidationSeverity,
  { label: string; color: string; bg: string }
> = {
  fatal:            { label: 'Fatal',           color: '#ff4d4d', bg: 'rgba(255,77,77,0.12)' },
  'layer-blocking': { label: 'Layer-Blocking',  color: '#F4A261', bg: 'rgba(244,162,97,0.12)' },
  'asset-blocking': { label: 'Asset-Blocking',  color: '#FFB703', bg: 'rgba(255,183,3,0.12)' },
  warning:          { label: 'Warnung',         color: '#2A9D8F', bg: 'rgba(42,157,143,0.12)' },
};

// -- Download helper -------------------------------------------------------

function downloadReport(report: ValidationReport) {
  const json = JSON.stringify(report, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `grid-validation-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// -- Main component --------------------------------------------------------

type FilterKey = 'all' | ValidationSeverity;

export default function ValidationPanel({ report, onClose }: Props) {
  const [filter, setFilter] = useState<FilterKey>('all');

  const filtered = useMemo<ValidationIssue[]>(() => {
    if (filter === 'all') return report.issues;
    return report.issues.filter((i) => i.severity === filter);
  }, [report.issues, filter]);

  const { summary, skippedAssets, generatedAt } = report;

  return (
    <>
      {/* Backdrop */}
      <div
        style={{
          position: 'absolute', inset: 0, zIndex: 440,
          background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(1px)',
        }}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Validierungsbericht"
        style={{
          position:     'absolute',
          top:          0,
          right:        0,
          bottom:       0,
          zIndex:       450,
          width:        360,
          maxWidth:     '90vw',
          background:   'var(--grid-surface, #1a1a2e)',
          borderLeft:   '1px solid var(--grid-border, rgba(255,255,255,0.12))',
          display:      'flex',
          flexDirection: 'column',
          fontSize:     12,
          color:        'var(--grid-text, #e0e0e0)',
          boxShadow:    '-4px 0 16px rgba(0,0,0,0.4)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display:       'flex',
            alignItems:    'center',
            justifyContent: 'space-between',
            padding:       '12px 14px',
            borderBottom:  '1px solid var(--grid-border, rgba(255,255,255,0.1))',
            flexShrink:    0,
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: '0.02em' }}>
              Validierungsbericht
            </div>
            {generatedAt && (
              <div style={{ opacity: 0.45, fontSize: 10, marginTop: 2 }}>
                {new Date(generatedAt).toLocaleString('de-DE')}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: 'none', color: 'inherit',
              cursor: 'pointer', fontSize: 16, opacity: 0.6, padding: '4px 6px',
            }}
            aria-label="Panel schließen"
          >
            ✕
          </button>
        </div>

        {/* Summary tiles */}
        <div
          style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr',
            gap: 6, padding: '10px 14px',
            borderBottom: '1px solid var(--grid-border, rgba(255,255,255,0.1))',
            flexShrink: 0,
          }}
        >
          <SummaryTile label="Fatal"          count={summary.fatal}            color="#ff4d4d" />
          <SummaryTile label="Layer-Blocking" count={summary.layerBlocking}    color="#F4A261" />
          <SummaryTile label="Asset-Blocking" count={summary.assetBlocking}    color="#FFB703" />
          <SummaryTile label="Warnungen"      count={summary.warnings}         color="#2A9D8F" />
        </div>

        {/* Filter chips */}
        <div
          style={{
            display:    'flex', gap: 6, padding: '8px 14px',
            borderBottom: '1px solid var(--grid-border, rgba(255,255,255,0.1))',
            flexShrink: 0, flexWrap: 'wrap',
          }}
        >
          {(['all', 'fatal', 'layer-blocking', 'asset-blocking', 'warning'] as FilterKey[]).map(
            (key) => {
              const count = key === 'all'
                ? report.issues.length
                : report.issues.filter((i) => i.severity === key).length;
              const active = filter === key;
              const meta   = key !== 'all' ? SEVERITY_META[key as ValidationSeverity] : null;
              return (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  style={{
                    background:   active ? (meta?.bg ?? 'rgba(255,255,255,0.12)') : 'transparent',
                    border:       `1px solid ${active ? (meta?.color ?? 'rgba(255,255,255,0.3)') : 'rgba(255,255,255,0.15)'}`,
                    borderRadius: 12,
                    color:        active ? (meta?.color ?? '#e0e0e0') : 'inherit',
                    cursor:       'pointer',
                    fontSize:     10,
                    padding:      '2px 8px',
                    opacity:      count === 0 ? 0.4 : 1,
                  }}
                >
                  {key === 'all' ? 'Alle' : SEVERITY_META[key as ValidationSeverity].label} ({count})
                </button>
              );
            },
          )}
        </div>

        {/* Issue list */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '6px 14px' }}>
          {filtered.length === 0 ? (
            <div style={{ opacity: 0.4, textAlign: 'center', paddingTop: 24, fontSize: 11 }}>
              Keine Einträge für diesen Filter.
            </div>
          ) : (
            filtered.map((issue, idx) => (
              <IssueRow key={`${issue.code}-${issue.uuid ?? idx}`} issue={issue} />
            ))
          )}

          {/* Skipped assets */}
          {skippedAssets && skippedAssets.length > 0 && (
            <>
              <div
                style={{
                  opacity: 0.5, fontSize: 10, letterSpacing: '0.04em',
                  textTransform: 'uppercase', marginTop: 14, marginBottom: 6,
                }}
              >
                Ausgeblendete Assets ({skippedAssets.length})
              </div>
              {skippedAssets.map((a) => (
                <div
                  key={a.uuid}
                  style={{
                    background:   'rgba(255,183,3,0.08)',
                    border:       '1px solid rgba(255,183,3,0.2)',
                    borderRadius: 4,
                    padding:      '4px 8px',
                    marginBottom: 4,
                    fontSize:     11,
                  }}
                >
                  <span style={{ opacity: 0.55 }}>{a.entityType}</span>
                  {' '}
                  <span style={{ fontFamily: 'monospace', fontSize: 10, opacity: 0.7 }}>
                    {a.uuid.slice(0, 8)}…
                  </span>
                  <span style={{ float: 'right', opacity: 0.5 }}>{a.reason}</span>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding:      '10px 14px',
            borderTop:    '1px solid var(--grid-border, rgba(255,255,255,0.1))',
            display:      'flex',
            gap:          8,
            flexShrink:   0,
          }}
        >
          <button
            onClick={() => downloadReport(report)}
            style={footerBtnStyle}
          >
            ↓ Bericht herunterladen
          </button>
          <button onClick={onClose} style={{ ...footerBtnStyle, opacity: 0.6 }}>
            Schließen
          </button>
        </div>
      </div>
    </>
  );
}

// -- Sub-components --------------------------------------------------------

function SummaryTile({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: string;
}) {
  return (
    <div
      style={{
        background:   `${color}18`,
        border:       `1px solid ${color}44`,
        borderRadius: 5,
        padding:      '6px 8px',
        display:      'flex',
        flexDirection: 'column',
        gap:          2,
      }}
    >
      <span style={{ fontSize: 18, fontWeight: 700, color, lineHeight: 1 }}>{count}</span>
      <span style={{ fontSize: 10, opacity: 0.65 }}>{label}</span>
    </div>
  );
}

function IssueRow({ issue }: { issue: ValidationIssue }) {
  const meta = SEVERITY_META[issue.severity] ?? SEVERITY_META.warning;
  return (
    <div
      style={{
        background:   meta.bg,
        border:       `1px solid ${meta.color}33`,
        borderRadius: 4,
        padding:      '5px 8px',
        marginBottom: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
        <span
          style={{
            background:   meta.color,
            color:        '#000',
            borderRadius: 3,
            fontSize:     9,
            fontWeight:   700,
            padding:      '1px 5px',
            textTransform: 'uppercase',
            letterSpacing: '0.03em',
            flexShrink:   0,
          }}
        >
          {meta.label}
        </span>
        <span style={{ fontFamily: 'monospace', fontSize: 10, opacity: 0.6 }}>
          {issue.code}
        </span>
        <span style={{ opacity: 0.4, fontSize: 10 }}>{issue.entityType}</span>
      </div>
      <div style={{ fontSize: 11, lineHeight: 1.4, opacity: 0.85 }}>{issue.message}</div>
      {issue.resolution && (
        <div style={{ fontSize: 10, opacity: 0.5, marginTop: 2, fontStyle: 'italic' }}>
          → {issue.resolution}
        </div>
      )}
      {issue.uuid && (
        <div style={{ fontFamily: 'monospace', fontSize: 9, opacity: 0.35, marginTop: 2 }}>
          {issue.uuid}
        </div>
      )}
    </div>
  );
}

// -- Shared styles ---------------------------------------------------------

const footerBtnStyle: React.CSSProperties = {
  flex:         1,
  background:   'rgba(255,255,255,0.08)',
  border:       '1px solid rgba(255,255,255,0.15)',
  borderRadius: 5,
  color:        'inherit',
  cursor:       'pointer',
  fontSize:     11,
  padding:      '6px 0',
};

// Re-export type for import convenience
export type { ValidationIssue };
