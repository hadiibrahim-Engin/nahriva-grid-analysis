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
  /** Interaction accent. */
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
  '#6fa4ef', '#64b7c2', '#9b8dd0', '#66bb94',
  '#e0aa54', '#d57c9b', '#8aa1b2', '#c08b68',
];
const PALETTE_LIGHT = [
  '#2e6db6', '#287f8d', '#6b58a7', '#2f8062',
  '#a96c18', '#a84f72', '#526f81', '#8d6045',
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
    primary: cssVar('--grid-primary', isLight ? '#2e6db6' : '#6fa4ef'),
    info: cssVar('--grid-info', isLight ? '#287f8d' : '#64b7c2'),
    success: cssVar('--grid-success', isLight ? '#2f8062' : '#66bb94'),
    warning: cssVar('--grid-warning', isLight ? '#a96c18' : '#e0aa54'),
    danger: cssVar('--grid-danger', isLight ? '#b94747' : '#ea7774'),
    // Translucent variant for glows / area fills. Keep alpha low so it
    // doesn't dominate against either background.
    primarySoft: cssVar('--grid-primary-soft', isLight ? 'rgba(46, 109, 182, 0.1)' : 'rgba(111, 164, 239, 0.13)'),
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
