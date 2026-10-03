/**
 * Theme-aware colour bundle for ECharts options.
 *
 * Reads the live CSS-variable values from
 * `document.documentElement` (so dark / light / system modes all work)
 * and re-publishes them whenever the user flips the theme toggle.
 *
 * The toggle in DashboardPage sets `documentElement.dataset.gridTheme`,
 * which triggers an attribute mutation; a `MutationObserver` here picks
 * that up and bumps a counter so every consuming chart re-reads its
 * colours and re-renders.
 */
import { useEffect, useState, useMemo } from 'react';

export interface ChartTheme {
  /** Per-series colour wheel. 8 slots, hand-picked for the active theme. */
  palette: string[];
  /** Axis line / tick colour. */
  axis: string;
  /** Split-line / grid colour (slightly more muted than axis). */
  grid: string;
  /** Tooltip + legend label colour. */
  text: string;
  /** Tooltip + legend muted/secondary text. */
  mutedText: string;
  /** Tooltip background. */
  tooltipBg: string;
  /** Tooltip border. */
  tooltipBorder: string;
  /** Brand primary. */
  primary: string;
  /** Status colours. */
  info: string;
  success: string;
  warning: string;
  danger: string;
  /** A semi-transparent variant of `primary` for soft fills / shadows. */
  primarySoft: string;
  /** True when the resolved theme is "light" (else dark). */
  isLight: boolean;
}

/** Per-mode palettes. Same hues — different saturations for contrast. */
const PALETTE_DARK = [
  '#60a5fa', '#34d399', '#fbbf24', '#f87171',
  '#a78bfa', '#22d3ee', '#fb7185', '#94a3b8',
];
const PALETTE_LIGHT = [
  '#2563eb', '#059669', '#d97706', '#dc2626',
  '#7c3aed', '#0891b2', '#be123c', '#64748b',
];

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

function resolveThemeIsLight(): boolean {
  if (typeof document === 'undefined') return false;
  const mode = document.documentElement.dataset.gridTheme;
  return mode === 'light';
}

function buildTheme(): ChartTheme {
  const isLight = resolveThemeIsLight();
  return {
    palette: isLight ? PALETTE_LIGHT : PALETTE_DARK,
    axis: cssVar('--grid-border', isLight ? '#d7dfea' : '#334155'),
    grid: cssVar('--grid-border-soft', isLight ? '#e5ebf2' : 'rgba(51, 65, 85, 0.7)'),
    text: cssVar('--grid-text-soft', isLight ? '#334155' : '#c7d0dd'),
    mutedText: cssVar('--grid-muted', isLight ? '#64748b' : '#9aa7b8'),
    tooltipBg: cssVar('--grid-surface-strong', isLight ? '#eef2f7' : '#18212d'),
    tooltipBorder: cssVar('--grid-border', isLight ? '#d7dfea' : '#334155'),
    primary: cssVar('--grid-primary', isLight ? '#2563eb' : '#3b82f6'),
    info: cssVar('--grid-info', isLight ? '#0891b2' : '#22d3ee'),
    success: cssVar('--grid-success', isLight ? '#16a34a' : '#22c55e'),
    warning: cssVar('--grid-warning', isLight ? '#b7791f' : '#f59e0b'),
    danger: cssVar('--grid-danger', isLight ? '#dc2626' : '#ef4444'),
    // Translucent variant for glows / area fills. Keep alpha low so it
    // doesn't dominate against either background.
    primarySoft: isLight
      ? 'rgba(37, 99, 235, 0.2)'
      : 'rgba(59, 130, 246, 0.3)',
    isLight,
  };
}

export function useChartTheme(): ChartTheme {
  // We re-bump this counter on any change to <html data-grid-theme>,
  // which forces buildTheme() to re-evaluate via the memo dep.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((v) => v + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-grid-theme', 'class'],
    });
    return () => observer.disconnect();
  }, []);

  return useMemo(() => {
    // `version` is used as an opaque "bump" trigger from the
    // MutationObserver above. Touch it so the linter doesn't strip
    // it from the dep array.
    void version;
    return buildTheme();
  }, [version]);
}
