/**
 * The address bar is the view: the analysis, grid, voltage level and scenario travel as query parameters
 * (?analysis=…&grid=…&kv=…&scenario=…), written whenever they change, so a copied link or a bookmark opens the
 * same results.
 */

/** A query parameter of the address the dashboard was opened with; null when absent. */
export function readParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(name);
}

/** Record one part of the view in the address (no reload, no new history entry); null removes it. */
export function writeParam(name: string, value: string | number | null): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, String(value));
  window.history.replaceState(window.history.state, '', url);
}

/** The address of the current view; a null value leaves its parameter out. */
export function shareUrl(params: Record<string, string | number | null>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== null) query.set(key, String(value));
  const search = query.toString();
  return `${window.location.origin}${window.location.pathname}${search ? `?${search}` : ''}`;
}

/**
 * The address of the current view with the analysis pinned: "the newest" is resolved to its id first, so the link
 * keeps showing the same results after a later PowerFactory run.
 */
export async function pinnedViewUrl(analysis: string | null, grid: string | null, kv: number | null): Promise<string> {
  const { default: api } = await import('../api/client');
  const pinned = analysis ?? (await api.get<{ default: string | null }>('/analyses')).data.default;
  return shareUrl({ analysis: pinned, grid, kv, scenario: readParam('scenario') });
}
