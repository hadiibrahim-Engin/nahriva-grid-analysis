/**
 * Reusable dropdown with a search filter and stable unique React keys.
 *
 * Scales to a few thousand options without virtualisation by filtering
 * before rendering and capping the visible list. For lists in the
 * tens-of-thousands range, swap the inner list for react-window.
 *
 * Used by the dashboard for Anlage, Betriebsmittel, Messgröße, and the
 * histogram series selector. The contract is intentionally narrow
 * (id/label/onChange) so the component is easy to repurpose.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Option } from '../util/dropdownOptions';
import { buildOptions, matchesSearch } from '../util/dropdownOptions';

interface Props<T> {
  label: string;
  items: readonly T[];
  /** Stable backend id used as the option value. */
  idOf: (item: T) => string;
  labelOf: (item: T) => string;
  /** Optional extra searchable text (id, alias, field number, …). When
   * provided, the search filter matches on label + this text. */
  searchOf?: (item: T) => string;
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  /** Max visible matches; default 200. Trims the rendered list when the
   * user hasn't filtered to something narrower yet. */
  maxVisible?: number;
  /** Hint shown when the search filter excludes everything. */
  emptyHint?: string;
  allowReset?: boolean;
  className?: string;
}

export default function SearchableDropdown<T>({
  label,
  items,
  idOf,
  labelOf,
  searchOf,
  value,
  onChange,
  placeholder = '- Auswahl -',
  disabled = false,
  loading = false,
  loadingLabel = 'Lädt…',
  maxVisible = 200,
  emptyHint = 'Keine Treffer',
  allowReset = true,
  className = '',
}: Props<T>) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const listboxId = useId();
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  const allOptions: Option[] = useMemo(
    () => buildOptions(items, idOf, labelOf, searchOf),
    [items, idOf, labelOf, searchOf],
  );

  const filtered = useMemo(
    () => allOptions.filter((o) => matchesSearch(o, query)),
    [allOptions, query],
  );
  const visible = useMemo(() => filtered.slice(0, maxVisible), [filtered, maxVisible]);
  const overflow = filtered.length - visible.length;

  const selectedLabel = useMemo(() => {
    if (!value) return null;
    return allOptions.find((o) => o.value === value)?.label ?? null;
  }, [allOptions, value]);

  const isDisabled = disabled || loading;

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!isDisabled) return;
    setOpen(false);
    setQuery('');
  }, [isDisabled]);

  // Re-anchor the keyboard-active option whenever the dropdown opens or the
  // filtered list changes shape: prefer the current selection, else the
  // first visible option, else none.
  useEffect(() => {
    if (!open) return;
    const selectedIndex = value ? visible.findIndex((o) => o.value === value) : -1;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : (visible.length > 0 ? 0 : -1));
  }, [open, visible, value]);

  useEffect(() => {
    if (activeIndex < 0) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, visible.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        event.preventDefault();
        if (activeIndex >= 0 && visible[activeIndex]) {
          onChange(visible[activeIndex].value);
          setOpen(false);
          setQuery('');
        }
        break;
      case 'Escape':
        // Close without changing the current selection.
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        setQuery('');
        triggerRef.current?.focus();
        break;
      default:
        break;
    }
  };

  return (
    <div className={`min-w-[180px] ${className}`} ref={containerRef}>
      <label className="grid-form-label">{label}</label>
      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          disabled={isDisabled}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-busy={loading}
          aria-label={label || placeholder}
          className={`grid-form-trigger ${open ? 'is-open' : ''} ${loading ? 'is-loading' : ''}`}
        >
          <span className="truncate">
            {selectedLabel ?? <span className="text-gray-400">{placeholder}</span>}
          </span>
          {loading ? (
            <span
              className="h-3 w-3 shrink-0 rounded-full border border-cyan-300/40 border-t-cyan-300 animate-spin"
              title={loadingLabel}
              aria-hidden
            />
          ) : (
            <span className="text-gray-500 text-xs">{open ? '▴' : '▾'}</span>
          )}
          {loading && (
            <span className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-gray-900/60">
              <span className="block h-full w-1/2 bg-gradient-to-r from-cyan-500 via-blue-400 to-cyan-500 animate-shimmer" />
            </span>
          )}
        </button>

        {open && !isDisabled && (
          <div className="grid-form-menu absolute z-30 mt-1 w-full max-h-72 overflow-hidden flex flex-col">
            <div className="grid-form-menu__search">
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Suchen…"
                className="grid-form-input"
                aria-label={`${label} Suche`}
                role="combobox"
                aria-expanded="true"
                aria-controls={listboxId}
                aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
                autoComplete="off"
              />
            </div>
            <div id={listboxId} role="listbox" className="overflow-y-auto">
              {value && allowReset && (
                <button
                  type="button"
                  onClick={() => { onChange(null); setOpen(false); setQuery(''); }}
                  className="grid-form-option grid-form-option--reset"
                >
                  Auswahl zurücksetzen
                </button>
              )}
              {visible.length === 0 ? (
                <div className="px-2 py-2 text-xs text-gray-500">{emptyHint}</div>
              ) : (
                visible.map((opt, index) => (
                  <button
                    key={opt.key}
                    id={optionId(index)}
                    ref={(el) => { optionRefs.current[index] = el; }}
                    type="button"
                    role="option"
                    aria-selected={opt.value === value}
                    onClick={() => { onChange(opt.value); setOpen(false); setQuery(''); }}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={`grid-form-option ${opt.value === value ? 'is-selected' : ''} ${index === activeIndex ? 'is-active' : ''}`}
                  >
                    {opt.label}
                  </button>
                ))
              )}
              {overflow > 0 && (
                <div className="px-2 py-1 text-[11px] text-gray-500 border-t border-gray-700/60">
                  {overflow.toLocaleString()} weitere – grenze die Suche ein
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
