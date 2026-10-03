import { useEffect, useRef, useState } from 'react';
import { useChartTheme } from '../../hooks/useChartTheme';

interface ColorSwatchPickerProps {
  value: string;
  onChange: (color: string) => void;
  label: string;
}

// Accept both shorthand (#rgb) and full (#rrggbb) hex, matching the colors
// the rest of the app normalizes (see normalizeThresholdLevelColor). A 6-only
// pattern silently reverted valid 3-digit input typed into the custom field.
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * In-app replacement for `<input type="color">`. The native color dialog is
 * an OS-level UI that can't be restyled with CSS, so it always looks out of
 * place against the dashboard theme. This instead offers a small popover of
 * swatches drawn from the same `--grid-*` tokens and chart palette used
 * everywhere else, plus a hex field for anything else.
 */
export default function ColorSwatchPicker({ value, onChange, label }: ColorSwatchPickerProps) {
  const [open, setOpen] = useState(false);
  const [customHex, setCustomHex] = useState(value);
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useChartTheme();

  useEffect(() => {
    if (open) setCustomHex(value);
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const swatches = Array.from(new Set([
    theme.warning, theme.danger, theme.info, theme.success, theme.primary,
    ...theme.palette,
  ]));

  function commitCustomHex() {
    if (HEX_RE.test(customHex)) onChange(customHex);
    else setCustomHex(value);
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative h-3 w-3 shrink-0 overflow-hidden rounded-full border border-[var(--grid-border)]"
        title={`${label} Farbe`}
        aria-label={`${label} Farbe`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span aria-hidden className="absolute inset-0" style={{ background: value }} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={`${label} Farbe wählen`}
          className="absolute left-0 top-5 z-[1000] w-36 rounded-lg border p-2 shadow-2xl"
          style={{ background: 'var(--grid-surface)', borderColor: 'var(--grid-border)' }}
        >
          <div className="grid grid-cols-5 gap-1.5">
            {swatches.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => { onChange(c); setOpen(false); }}
                className="h-5 w-5 shrink-0 rounded-full transition-transform hover:scale-110"
                style={{
                  background: c,
                  outline: c.toLowerCase() === value.toLowerCase() ? `2px solid ${theme.text}` : 'none',
                  outlineOffset: 1,
                }}
                title={c}
                aria-label={`Farbe ${c}`}
              />
            ))}
          </div>
          <label className="mt-2 flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--grid-muted)' }}>
            Eigene
            <input
              type="text"
              value={customHex}
              onChange={(e) => setCustomHex(e.target.value)}
              onBlur={commitCustomHex}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { commitCustomHex(); setOpen(false); }
              }}
              placeholder="#rrggbb"
              className="grid-form-input grid-form-input--compact h-5 w-20"
            />
          </label>
        </div>
      )}
    </div>
  );
}
