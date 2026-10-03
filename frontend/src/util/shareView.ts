// Dashboard view persistence + sharing.
//
//   1. Reload-safe: the view is saved to localStorage (no length limit), so a
//      refresh — or recovery after a dropped connection — restores it.
//   2. Shareable: sharing stores the view server-side and puts only a short
//      id in the URL (?s=<id>), so links stay small no matter how many charts
//      the view contains. A share can also carry a frozen data snapshot.
//
// A legacy inline `?view=<base64url(JSON)>` param is still decoded on load for
// backward compatibility, but no longer written.

import type { DashboardChartConfig } from './dynamicCharts';

const PARAM = 'view';        // legacy inline view (read-only now)
const SHARE_PARAM = 's';     // server share id
const LOCAL_KEY = 'powerfactoryDashboardView';
const LAST_SHARE_LINK_KEY = 'powerfactoryDashboardLastShareLink';

export interface SharedSeries {
  key: string;
  facilityName: string;
  facilityId: string;
  componentId: string;
  componentName: string;
  measurementType: string;
}

export interface SharedView {
  v: 1;
  fac: string | null;
  cmp: string | null;
  mt: string;
  series: SharedSeries[];
  charts: DashboardChartConfig[];
  /** IDs of the optional views the user has added — 'timeseries', 'heatmap',
   * 'peakDemand'. Absent or empty means only the summary is shown. */
  panels?: string[];
}

function toB64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeView(view: SharedView): string {
  return toB64Url(JSON.stringify(view));
}

export function decodeView(raw: string): SharedView | null {
  try {
    const obj = JSON.parse(fromB64Url(raw));
    if (!obj || obj.v !== 1 || !Array.isArray(obj.series) || !Array.isArray(obj.charts)) {
      return null;
    }
    return obj as SharedView;
  } catch {
    return null;
  }
}

/** Legacy inline view param — still decoded for old links. */
export function readViewFromUrl(search: string = window.location.search): SharedView | null {
  const raw = new URLSearchParams(search).get(PARAM);
  return raw ? decodeView(raw) : null;
}

/** Server share id from the URL (?s=<id>), if present. */
export function readShareIdFromUrl(search: string = window.location.search): string | null {
  return new URLSearchParams(search).get(SHARE_PARAM);
}

/** Absolute, copy-pasteable link to a server-stored share. */
export function buildShareLink(id: string): string {
  return `${window.location.origin}${window.location.pathname}?${SHARE_PARAM}=${encodeURIComponent(id)}`;
}

// --- reload persistence via localStorage (no URL length limit) ---

export function saveLocalView(view: SharedView): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(view));
  } catch {
    /* quota / privacy mode — non-fatal */
  }
}

export function loadLocalView(): SharedView | null {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.v !== 1 || !Array.isArray(obj.series) || !Array.isArray(obj.charts)) return null;
    return obj as SharedView;
  } catch {
    return null;
  }
}

export function clearLocalView(): void {
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* ignore */
  }
}

export function saveLastShareLink(url: string): void {
  try {
    localStorage.setItem(LAST_SHARE_LINK_KEY, url);
  } catch {
    /* ignore */
  }
}

/**
 * Best-effort clipboard write tied to the *current* user gesture, even
 * though the value to copy isn't known yet — it resolves after the
 * create-share network round trip.
 *
 * Browsers (Safari in particular, increasingly Chrome too) tie clipboard
 * permission to synchronous user-activation: any `await` before the write
 * (e.g. `await createShare(...)`) lets that activation expire, so a plain
 * `navigator.clipboard.writeText` made afterwards silently fails. Passing a
 * promise-based `ClipboardItem` keeps the permission check synchronous (it
 * fires the moment this function is called) while the actual text is filled
 * in once `urlPromise` settles.
 *
 * Must be called synchronously from the click handler — no `await` before it.
 */
export function writeClipboardDeferred(urlPromise: Promise<string>): Promise<boolean> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      const blobPromise = urlPromise.then((url) => new Blob([url], { type: 'text/plain' }));
      const item = new ClipboardItem({ 'text/plain': blobPromise });
      return navigator.clipboard.write([item]).then(() => true).catch(() => false);
    } catch {
      /* ClipboardItem constructed but write() threw synchronously — fall through */
    }
  }
  return urlPromise.then((url) => copyShareLinkToClipboard(url));
}

export async function copyShareLinkToClipboard(url: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      /* fall back to the selection API below */
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = url;
  textarea.readOnly = true;
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, url.length);

  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

