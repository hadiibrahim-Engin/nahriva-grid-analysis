import { useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react';
import { OPEN_SECTION_EVENT } from '../../util/acrossScenarios';
import { LOADING_BANDS } from '../../config/loadingBands';
import { useHelp } from './help';
import type { AcrossScenario } from '../../util/acrossScenarios';

export function SectionCard({ title, hint, actions, children, collapsible = true, defaultOpen = true, summary, id, className = '' }: {
  title: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
  /** Header becomes a toggle; the body is only rendered while open. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** One line shown under the title while the section is collapsed. */
  summary?: ReactNode;
  id?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const help = useHelp();
  const [hintOpen, setHintOpen] = useState(false);
  const showHint = help || hintOpen;
  useEffect(() => {
    if (!id) return;
    const open = (event: Event) => { if ((event as CustomEvent<string>).detail === id) setOpen(true); };
    window.addEventListener(OPEN_SECTION_EVENT, open);
    return () => window.removeEventListener(OPEN_SECTION_EVENT, open);
  }, [id]);
  const expanded = !collapsible || open;
  const heading = (
    <div className="min-w-0">
      <h3 className="across-card__title">{title}</h3>
      {expanded && hint && showHint && <p className="across-card__hint">{hint}</p>}
      {!expanded && summary && <p className="across-card__hint">{summary}</p>}
    </div>
  );
  return (
    <section id={id} className={`across-card ${className}${collapsible && !expanded ? ' across-card--collapsed' : ''}`}>
      <header className="across-card__head">
        {collapsible ? (
          <button type="button" className="across-card__toggle" aria-label={`${title} ${expanded ? 'collapse' : 'expand'}`} aria-expanded={expanded} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
            <svg className="across-card__chevron" width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M5 6l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {heading}
          </button>
        ) : heading}
        {expanded && (hint || actions) && (
          <div className="across-card__actions">
            {hint && (
              <button type="button" className="ab-info" aria-pressed={showHint} disabled={help} title="Show or hide the explanation" aria-label={`Explanation of ${title}`} onClick={() => setHintOpen((v) => !v)}>i</button>
            )}
            {actions}
          </div>
        )}
      </header>
      <div id={bodyId} hidden={!expanded}>{expanded && children}</div>
    </section>
  );
}

export function BandLegend() {
  return (
    <ul className="ab-legend" aria-label="Loading bands">
      {LOADING_BANDS.map((band) => (
        <li key={band.id}>
          <span className={`ab-swatch ab-fill--${band.id}`} aria-hidden />
          <span className="ab-legend__label">{band.label}</span>
          <span className="ab-legend__range">{band.range}</span>
        </li>
      ))}
    </ul>
  );
}

/** Short scenario code with the full name on hover. */
export function ScenarioTag({ code, scenario }: { code: string; scenario?: AcrossScenario | null }) {
  return <span className="ab-code" title={scenario?.name}>{code}</span>;
}

/** Horizontal in-cell bar: the exact value stays readable next to a subtle length indicator. */
export function DataBar({ value, scale, text, color, strong = false, title }: {
  value: number | null;
  scale: number;
  text: string;
  color: string;
  strong?: boolean;
  title?: string;
}) {
  const pct = value === null || scale <= 0 ? 0 : Math.min(Math.max(value / scale, 0), 1) * 100;
  return (
    <div className={`ab-bar${strong ? ' ab-bar--strong' : ''}`} style={{ '--c': color } as CSSProperties} title={title}>
      <span className="ab-bar__num">{text}</span>
      <span className="ab-bar__track" aria-hidden><span className="ab-bar__fill" style={{ width: `${pct}%` }} /></span>
    </div>
  );
}

/** Diverging bar around a neutral zero axis: left = reduction, right = increase. */
export function DivergingBar({ value, scale, text, strong = false, title }: {
  value: number | null;
  scale: number;
  text: string;
  strong?: boolean;
  title?: string;
}) {
  const half = value === null || scale <= 0 ? 0 : Math.min(Math.abs(value) / scale, 1) * 50;
  const positive = (value ?? 0) >= 0;
  const style: CSSProperties = {
    '--c': positive ? 'var(--ab-pos)' : 'var(--ab-neg)',
  } as CSSProperties;
  const fill: CSSProperties = positive ? { left: '50%', width: `${half}%` } : { right: '50%', width: `${half}%` };
  return (
    <div className={`ab-bar ab-bar--div${strong ? ' ab-bar--strong' : ''}`} style={style} title={title}>
      <span className="ab-bar__num">{text}</span>
      <span className="ab-bar__track" aria-hidden>
        <span className="ab-bar__axis" />
        <span className="ab-bar__fill" style={fill} />
      </span>
    </div>
  );
}
