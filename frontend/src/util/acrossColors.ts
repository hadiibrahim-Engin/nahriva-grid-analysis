import type { BandId } from '../config/loadingBands.ts';

export interface AcrossColors {
  bands: Record<BandId, string>;
  pos: string;
  neg: string;
  lodf: string;
}

const FALLBACK_LIGHT: AcrossColors = {
  bands: { ok: '#719481', high: '#bd8d32', light: '#d7793f', clear: '#c8665c', severe: '#ab3436' },
  pos: '#c65722',
  neg: '#277d91',
  lodf: '#426ed0',
};
const FALLBACK_DARK: AcrossColors = {
  bands: { ok: '#83a593', high: '#d8ae55', light: '#f29c65', clear: '#dd7d77', severe: '#bc474c' },
  pos: '#f29c65',
  neg: '#58bfc6',
  lodf: '#7098f1',
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
