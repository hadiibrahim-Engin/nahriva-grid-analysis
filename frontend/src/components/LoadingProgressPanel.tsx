import { useMemo, useState } from 'react';

export type QueryPipelineStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'partial'
  | 'error'
  | 'cached';

export interface QueryPipelineItem {
  id: string;
  label: string;
  status: QueryPipelineStatus;
  progress: number;
  message: string;
}

interface Props {
  items: QueryPipelineItem[];
  inFlight?: number;
}

const STATUS_LABELS: Record<QueryPipelineStatus, string> = {
  queued: 'queued',
  running: 'running',
  done: 'done',
  partial: 'partial',
  error: 'error',
  cached: 'cached',
};

const STATUS_ORDER: Record<QueryPipelineStatus, number> = {
  error: 0,
  running: 1,
  partial: 2,
  queued: 3,
  cached: 4,
  done: 5,
};

function clampProgress(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function overallProgress(items: QueryPipelineItem[]): number {
  if (items.length === 0) return 0;
  return clampProgress(items.reduce((sum, item) => sum + item.progress, 0) / items.length);
}

function overallStatus(items: QueryPipelineItem[]): QueryPipelineStatus {
  return [...items].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])[0]?.status ?? 'queued';
}

function statusText(status: QueryPipelineStatus): string {
  if (status === 'running') return 'Pipeline läuft';
  if (status === 'error') return 'Fehler prüfen';
  if (status === 'partial') return 'Teilweise geladen';
  if (status === 'queued') return 'Wartet';
  if (status === 'cached') return 'Cache aktiv';
  return 'Bereit';
}

export default function LoadingProgressPanel({ items, inFlight = 0 }: Props) {
  const [isHovered, setIsHovered] = useState(false);
  const expanded = isHovered;
  const progress = useMemo(() => overallProgress(items), [items]);
  const status = useMemo(() => overallStatus(items), [items]);
  const runningCount = items.filter((item) => item.status === 'running').length;
  const issueCount = items.filter((item) => item.status === 'error' || item.status === 'partial').length;

  return (
    <aside
      className={`query-sidebar ${expanded ? 'query-sidebar--expanded' : ''}`}
      aria-label="Query- und Berechnungsfortschritt"
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
      onFocus={() => setIsHovered(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsHovered(false);
        }
      }}
    >
      <div
        className="query-sidebar__rail"
        aria-label="Query Monitor öffnen"
        aria-expanded={expanded}
        role="button"
        tabIndex={0}
      >
        <div className={`query-sidebar__dot query-sidebar__dot--${status}`} />
        <div className="query-sidebar__glyph">Q</div>
        <div className="query-sidebar__rail-meter">
          <span style={{ height: `${progress}%` }} />
        </div>
        <div className="query-sidebar__rail-progress">{progress}%</div>
      </div>

      <div className="query-sidebar__panel">
        <div className="query-sidebar__header">
          <div>
            <div className="query-sidebar__eyebrow">Simulationsergebnisse</div>
            <h2>Query Monitor</h2>
            <p>{statusText(status)} · {inFlight} HTTP aktiv · {runningCount} laufend</p>
          </div>
        </div>

        <div
          className="query-sidebar__overall"
          title="Der Gesamtwert ist ein Frontend-Komposit aus den einzelnen Pipeline-Schritten. Wenn eine API keinen echten Prozentwert liefert, nutzt das Dashboard den aktuellen Loading-/Done-/Error-Status als Näherung."
        >
          <div className="query-sidebar__overall-top">
            <span>Gesamtfortschritt</span>
            <strong>{progress}%</strong>
          </div>
          <div className="query-sidebar__bar query-sidebar__bar--overall">
            <span style={{ width: `${progress}%` }} />
          </div>
          {issueCount > 0 && (
            <div className="query-sidebar__warning">
              {issueCount} Pipeline-Schritt{issueCount === 1 ? '' : 'e'} braucht Aufmerksamkeit.
            </div>
          )}
        </div>

        <div className="query-sidebar__items">
          {items.map((item) => (
            <div key={item.id} className={`query-sidebar__item query-sidebar__item--${item.status}`}>
              <div className="query-sidebar__item-head">
                <span className="query-sidebar__item-title">{item.label}</span>
                <span className="query-sidebar__status">
                  {item.status === 'running' && <span className="query-sidebar__spinner" aria-hidden />}
                  {STATUS_LABELS[item.status]}
                </span>
              </div>
              <div className="query-sidebar__message">{item.message}</div>
              <div className="query-sidebar__bar">
                <span style={{ width: `${clampProgress(item.progress)}%` }} />
              </div>
              <div className="query-sidebar__percent">{clampProgress(item.progress)}%</div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
