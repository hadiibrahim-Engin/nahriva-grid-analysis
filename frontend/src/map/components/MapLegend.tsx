/**
 * MapLegend — floating legend overlay rendered as a React component.
 *
 * Shows:
 *   • Voltage-level colour swatches (only for levels present in the dataset)
 *   • Status dash patterns (solid / dashed / dotted)
 *   • Line type patterns (overhead / cable / mixed)
 *
 * Positioned bottom-right of the map container via absolute CSS.
 * Collapsible on mobile.
 */
import React, { useState } from 'react';
import { VOLTAGE_COLORS, VOLTAGE_LEVELS_ORDERED } from '../constants';

interface Props {
  /** Voltage levels that actually appear in the loaded dataset. */
  voltageLevels: string[];
  className?: string;
}

const KV_LABELS: Record<string, string> = {
  '380': '380 kV',
  '220': '220 kV',
  '110': '110 kV',
  '66':  '66 kV',
  '36':  '36 kV',
  '20':  '20 kV',
  '10':  '10 kV',
  '6':   '6 kV',
  '1':   '1 kV',
  '0.4': '0,4 kV',
};

export default function MapLegend({ voltageLevels, className = '' }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  // Only show voltage levels that appear in the dataset, in standard order
  const presentLevels = VOLTAGE_LEVELS_ORDERED.filter((v) =>
    voltageLevels.includes(v),
  );

  return (
    <div
      className={`map-legend ${className}`}
      style={{
        position: 'absolute',
        bottom: 28,
        right: 10,
        zIndex: 400,
        background: 'var(--grid-surface)',
        border: '1px solid var(--grid-border)',
        borderRadius: 8,
        padding: collapsed ? '6px 10px' : '10px 12px',
        fontSize: 11,
        color: 'var(--grid-text)',
        minWidth: 110,
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        userSelect: 'none',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: collapsed ? 0 : 6,
          cursor: 'pointer',
          fontWeight: 600,
          opacity: 0.85,
          fontSize: 11,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}
        onClick={() => setCollapsed((c) => !c)}
        role="button"
        aria-expanded={!collapsed}
        aria-label="Legende ein-/ausblenden"
      >
        <span>Legende</span>
        <span style={{ opacity: 0.5, fontSize: 10 }}>{collapsed ? '▲' : '▼'}</span>
      </div>

      {!collapsed && (
        <>
          {/* Voltage levels */}
          {presentLevels.length > 0 && (
            <section aria-label="Spannungsebenen">
              <div style={{ opacity: 0.55, fontSize: 10, marginBottom: 4, letterSpacing: '0.03em' }}>
                SPANNUNG
              </div>
              {presentLevels.map((v) => (
                <div key={v} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 22,
                      height: 3,
                      borderRadius: 2,
                      background: VOLTAGE_COLORS[v] ?? VOLTAGE_COLORS.unknown,
                      flexShrink: 0,
                    }}
                  />
                  <span>{KV_LABELS[v] ?? `${v} kV`}</span>
                </div>
              ))}
            </section>
          )}

          {/* Divider */}
          <div style={{ borderTop: '1px solid var(--grid-border)', margin: '7px 0' }} />

          {/* Status patterns */}
          <section aria-label="Status">
            <div style={{ opacity: 0.55, fontSize: 10, marginBottom: 4, letterSpacing: '0.03em' }}>
              STATUS
            </div>
            <LegendDashRow dash="solid"   label="In Betrieb" />
            <LegendDashRow dash="dashed"  label="In Planung" />
            <LegendDashRow dash="dotted"  label="Unbekannt" />
          </section>

          {/* Divider */}
          <div style={{ borderTop: '1px solid var(--grid-border)', margin: '7px 0' }} />

          {/* Line type */}
          <section aria-label="Leitungstyp">
            <div style={{ opacity: 0.55, fontSize: 10, marginBottom: 4, letterSpacing: '0.03em' }}>
              TYP
            </div>
            <LegendTypeRow type="overhead" label="Freileitung" />
            <LegendTypeRow type="cable"    label="Kabel" />
            <LegendTypeRow type="mixed"    label="Gemischt" />
          </section>
        </>
      )}
    </div>
  );
}

// -- Sub-components --------------------------------------------------------

function LegendDashRow({ dash, label }: { dash: 'solid' | 'dashed' | 'dotted'; label: string }) {
  const style: React.CSSProperties = {
    display: 'inline-block',
    width: 22,
    height: 3,
    borderRadius: dash === 'solid' ? 2 : 0,
    background: dash === 'solid' ? '#888' : 'transparent',
    borderTop: dash === 'dashed'
      ? '2px dashed #888'
      : dash === 'dotted'
        ? '2px dotted #888'
        : 'none',
    flexShrink: 0,
    marginTop: 1,
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
      <span style={style} />
      <span>{label}</span>
    </div>
  );
}

function LegendTypeRow({ type, label }: { type: 'overhead' | 'cable' | 'mixed'; label: string }) {
  const style: React.CSSProperties = {
    display: 'inline-block',
    width: 22,
    height: 3,
    background: type === 'overhead' ? '#888'
               : type === 'cable'    ? 'transparent'
               : 'transparent',
    borderTop: type === 'cable'
      ? '2px dotted #888'
      : type === 'mixed'
        ? '2px dashed #888'
        : 'none',
    borderRadius: type === 'overhead' ? 2 : 0,
    flexShrink: 0,
    marginTop: 1,
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
      <span style={style} />
      <span>{label}</span>
    </div>
  );
}
