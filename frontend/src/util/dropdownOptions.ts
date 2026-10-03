// Helpers for building dropdown option lists that survive backend edge
// cases. Used by the dashboard's scenario / equipment / measurement /
// histogram selectors.

export interface Option {
  /** Stable unique key for React. Never collides even if the backend
   * returns rows with NULL ids or duplicate composite keys. */
  key: string;
  /** The id sent to the backend when this option is selected. */
  value: string;
  /** Display label. */
  label: string;
  /** Optional searchable text in addition to `label`. Lets the dropdown
   * match on ids, aliases, or field numbers that don't belong in the
   * visible label. Lowercased once at build time so filtering stays cheap. */
  searchText?: string;
}

/** Dedupe a list by an id selector, preserving order of first occurrence.
 * Rows whose id is null/undefined/empty are dropped. */
export function dedupeById<T>(items: readonly T[], idOf: (item: T) => string | null | undefined): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const id = idOf(item);
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

/** Build dropdown options from a list. The key includes the array index
 * as a last-resort suffix so even if id collisions slip through, React
 * never sees duplicate keys.
 *
 * `searchOf` is optional extra text to make searchable (id, alias, field
 * number, …). When passed, both the visible label AND the extra text
 * count toward `matchesSearch`. */
export function buildOptions<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  labelOf: (item: T) => string,
  searchOf?: (item: T) => string,
): Option[] {
  const deduped = dedupeById(items, idOf);
  return deduped.map((item, index) => {
    const id = idOf(item);
    const label = labelOf(item);
    const extra = searchOf?.(item);
    return {
      key: `${id}#${index}`,
      value: id,
      label,
      searchText: extra ? `${label} ${extra}`.toLowerCase() : undefined,
    };
  });
}

/** Case-insensitive multi-token AND filter used by SearchableDropdown.
 * Every whitespace-separated token in `query` must appear in `option.searchText`
 * (falling back to `label`). So "transformer a 110" matches a 110 kV transformer
 * named "Transformer A". */
export function matchesSearch(option: Option, query: string): boolean {
  if (!query) return true;
  const haystack = option.searchText ?? option.label.toLowerCase();
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((t) => haystack.includes(t));
}
