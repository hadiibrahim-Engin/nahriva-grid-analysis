import type { CSSProperties } from 'react';
import { VERDICTS, type Verdict } from '../../config/assessment';

/** Verdict as icon + label + colour, so the state never rests on colour alone. */
export default function VerdictBadge({ verdict, title }: { verdict: Verdict; title?: string }) {
  const meta = VERDICTS[verdict];
  return (
    <span className={`ab-verdict ab-verdict--${verdict}`} title={title ?? meta.description} style={{ '--v': `var(--ab-v-${verdict})` } as CSSProperties}>
      <span className="ab-verdict__glyph" aria-hidden>{meta.glyph}</span>
      {meta.label}
    </span>
  );
}
