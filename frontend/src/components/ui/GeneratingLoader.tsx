/**
 * GeneratingLoader — the canonical loader for every chart generation / chart-card
 * initial load state.
 *
 * This is the provided "Generating" loader (rotating gradient ring + per-letter
 * fade). styled-components is not in the dependency set, so the visual is ported
 * to plain CSS classes in index.css (`.gen-loader*`) — identical behaviour and
 * appearance, no extra dependency.
 */
const LETTERS = 'Generating'.split('');

interface Props {
  /** Minimum height of the loader area so the card doesn't collapse. */
  minHeight?: number;
}

export default function GeneratingLoader({ minHeight = 220 }: Props) {
  return (
    <div
      className="flex items-center justify-center"
      style={{ minHeight }}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Generating"
    >
      <div className="gen-loader-wrapper">
        {LETTERS.map((ch, i) => (
          <span key={`${ch}-${i}`} className="gen-loader-letter">{ch}</span>
        ))}
        <div className="gen-loader" />
      </div>
    </div>
  );
}
