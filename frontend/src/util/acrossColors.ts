import type { BandId } from '../config/loadingBands.ts';

export interface AcrossColors {
  bands: Record<BandId, string>;
  pos: string;
  neg: string;
  lodf: string;
}

const FALLBACK_LIGHT: AcrossColors = {
  bands: { ok: '#2f8062', high: '#a96c18', light: '#c4642f', clear: '#bd554f', severe: '#a93b3b' },
  pos: '#c4642f',
  neg: '#287f8d',
  lodf: '#376db8',
};
const FALLBACK_DARK: AcrossColors = {
  bands: { ok: '#66bb94', high: '#e0aa54', light: '#e99155', clear: '#e47b70', severe: '#c94f55' },
  pos: '#e99155',
  neg: '#64b7c2',
  lodf: '#6f9fe8',
};

/** Reads the per-theme band hues (--ab-*) so charts follow the light/dark definition in index.css. */
export function readAcrossColors(isLight: boolean): AcrossColors {
  const FALLBACK = isLight ? FALLBACK_LIGHT : FALLBACK_DARK;
  if (typeof document === 'undefined') return FALLBACK;
  const el = document.querySelector('.across-scope') ?? document.documentElement;
  const style = getComputedStyle(el);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    bands: {
      ok: read('--ab-ok', FALLBACK.bands.ok),
      high: read('--ab-high', FALLBACK.bands.high),
      light: read('--ab-light', FALLBACK.bands.light),
      clear: read('--ab-clear', FALLBACK.bands.clear),
      severe: read('--ab-severe', FALLBACK.bands.severe),
    },
    pos: read('--ab-pos', FALLBACK.pos),
    neg: read('--ab-neg', FALLBACK.neg),
    lodf: read('--ab-lodf', FALLBACK.lodf),
  };
}

/** #RRGGBB + alpha (0..1) → #RRGGBBAA. Other colour formats are returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  return color + Math.round(Math.min(Math.max(alpha, 0), 1) * 255).toString(16).padStart(2, '0');
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
