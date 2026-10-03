/**
 * FeatureTooltip — floating tooltip that follows the cursor over map features.
 *
 * Rendered via a React portal into document.body so it can safely exceed
 * the map container's clip boundary.
 *
 * Displays:
 *   • Station: name, short identifier, all voltage levels, status
 *   • Line:    name, voltage, lineType, status, circuits, length
 *   • Mast:    name/uuid snippet, voltageBreakdown, mastType
 *
 * Props:
 *   • feature — HoveredFeature | null  (null = hidden)
 *
 * The caller (GridMapLibre) tracks mousemove and updates HoveredFeature.x/y.
 * The tooltip auto-flips horizontally when near the right edge.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { HoveredFeature } from '../types';
import { voltageColor } from '../constants';

interface Props {
  feature: HoveredFeature | null;
}

// -- Status display --------------------------------------------------------

const STATUS_LABELS: Record<string, string> = {
  in_operation: 'In Betrieb',
  planned:      'In Planung',
  unknown:      'Unbekannt',
};

const STATUS_COLORS: Record<string, string> = {
  in_operation: '#2A9D8F',
  planned:      '#F4A261',
  unknown:      '#9E9E9E',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      style={{
        display:      'inline-block',
        background:   `${STATUS_COLORS[status] ?? '#9e9e9e'}22`,
        border:       `1px solid ${STATUS_COLORS[status] ?? '#9e9e9e'}66`,
        borderRadius: 3,
        color:        STATUS_COLORS[status] ?? '#9e9e9e',
        fontSize:     9,
        fontWeight:   600,
        letterSpacing: '0.04em',
        padding:      '1px 5px',
        textTransform: 'uppercase',
      }}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function VoltageChip({ level }: { level: string }) {
  const color = voltageColor(level);
  return (
    <span
      style={{
        display:      'inline-flex',
        alignItems:   'center',
        gap:          4,
        background:   `${color}22`,
        border:       `1px solid ${color}55`,
        borderRadius: 3,
        color,
        fontSize:     9,
        fontWeight:   600,
        padding:      '1px 5px',
      }}
    >
      <span
        style={{
          display:      'inline-block',
          width:        6,
          height:       6,
          borderRadius: '50%',
          background:   color,
          flexShrink:   0,
        }}
      />
      {level} kV
    </span>
  );
}

// -- Inner content per entity type -----------------------------------------

function StationContent({ f }: { f: HoveredFeature }) {
  const levels = f.spannungsebenen ?? [f.voltageLevel];
  return (
    <>
      <div style={nameStyle}>{f.name}</div>
      {f.name !== f.voltageLevel && (
        <div style={{ opacity: 0.5, fontSize: 10, marginBottom: 6 }}>
          {/* identifierKurz if different from name */}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
        {levels.map((v) => <VoltageChip key={v} level={v} />)}
      </div>
      <StatusBadge status={f.status} />
    </>
  );
}

function LineContent({ f }: { f: HoveredFeature }) {
  const lineTypeLabel = f.lineType === 'cable'
    ? 'Kabel'
    : f.lineType === 'mixed'
      ? 'Gemischt'
      : 'Freileitung';

  return (
    <>
      <div style={nameStyle}>{f.name}</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
        <VoltageChip level={f.voltageLevel} />
        <span style={{ opacity: 0.55, fontSize: 10 }}>{lineTypeLabel}</span>
      </div>
      <StatusBadge status={f.status} />
    </>
  );
}

function MastContent({ f }: { f: HoveredFeature }) {
  const breakdown = f.voltageBreakdown ?? [f.voltageLevel];
  return (
    <>
      <div style={{ ...nameStyle, fontFamily: 'monospace', fontSize: 11 }}>
        {f.name ?? `Mast …${f.uuid.slice(-6)}`}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
        {breakdown.map((v) => <VoltageChip key={v} level={v} />)}
      </div>
      <StatusBadge status={f.status} />
    </>
  );
}

// -- Tooltip ---------------------------------------------------------------

const OFFSET_X = 14;
const OFFSET_Y = -10;
const TOOLTIP_WIDTH = 200;

export default function FeatureTooltip({ feature }: Props) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(false);

  useEffect(() => {
    if (!feature || !tooltipRef.current) return;
    const vpw = window.innerWidth;
    setFlip(feature.x + OFFSET_X + TOOLTIP_WIDTH > vpw - 16);
  }, [feature?.x, feature?.y]);

  if (!feature) return null;

  const left = flip
    ? feature.x - TOOLTIP_WIDTH - OFFSET_X
    : feature.x + OFFSET_X;
  const top  = feature.y + OFFSET_Y;

  const typeLabel =
    feature.type === 'station' ? 'Umspannwerk' :
    feature.type === 'line'    ? 'Leitung'     : 'Mast';

  return createPortal(
    <div
      ref={tooltipRef}
      role="tooltip"
      style={{
        position:       'fixed',
        left,
        top,
        zIndex:         9999,
        background:     'var(--grid-surface, #1a1a2e)',
        border:         '1px solid var(--grid-border, rgba(255,255,255,0.14))',
        borderRadius:   7,
        padding:        '8px 11px',
        width:          TOOLTIP_WIDTH,
        fontSize:       11,
        color:          'var(--grid-text, #e0e0e0)',
        boxShadow:      '0 4px 16px rgba(0,0,0,0.45)',
        pointerEvents:  'none',
        transition:     'opacity 0.1s',
        userSelect:     'none',
      }}
    >
      {/* Entity type label */}
      <div
        style={{
          opacity:       0.45,
          fontSize:      9,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          marginBottom:  4,
        }}
      >
        {typeLabel}
      </div>

      {feature.type === 'station' && <StationContent f={feature} />}
      {feature.type === 'line'    && <LineContent    f={feature} />}
      {feature.type === 'mast'    && <MastContent    f={feature} />}
    </div>,
    document.body,
  );
}

// -- Shared styles ---------------------------------------------------------

const nameStyle: React.CSSProperties = {
  fontWeight:   600,
  fontSize:     12,
  marginBottom: 5,
  lineHeight:   1.3,
  overflow:     'hidden',
  textOverflow: 'ellipsis',
  whiteSpace:   'nowrap',
  maxWidth:     178,
};
