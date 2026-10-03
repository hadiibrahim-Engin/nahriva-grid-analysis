import type { ReactNode } from 'react';
import { SectionCard } from './across/shared';
import GeneratingLoader from './ui/GeneratingLoader';

interface Props {
  title: string;
  hint?: string;
  loading?: boolean;
  error?: string | null;
  /**
   * True when there is genuinely no data (null / empty array).
   * False even when data is from a previous request (optimistic display).
   */
  isEmpty?: boolean;
  children: ReactNode;
}

export default function DataSection({ title, hint, loading, error, isEmpty, children }: Props) {
  if (error) {
    return (
      <SectionCard title={title} hint={hint}>
        <div className="flex items-start gap-3 py-3 px-4 bg-red-900/20 rounded border border-red-800/40">
          <span className="text-red-400 text-xl shrink-0">⚠</span>
          <div>
            <div className="text-sm text-red-300 font-semibold">{title} konnte nicht angezeigt werden</div>
            <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-red-300/80">Ursache</div>
            <div className="text-xs text-red-400/80 mt-1 font-mono whitespace-pre-wrap">{error}</div>
          </div>
        </div>
      </SectionCard>
    );
  }

  // -- Refresh (data exists but is being updated) ---------------------
  // Show the stale chart immediately; a thin animated stripe at the top
  // signals that newer data is on its way — no skeleton flash.
  if (loading && !isEmpty) {
    return (
      <div className="relative">
        {/* Refresh indicator stripe */}
        <div
          aria-hidden
          className="absolute top-0 inset-x-0 h-0.5 z-10 overflow-hidden rounded-t-lg"
        >
          <div className="h-full bg-gradient-to-r from-cyan-500 via-blue-400 to-cyan-500 animate-shimmer" />
        </div>
        {children}
      </div>
    );
  }

  // -- Initial load (no data yet) -------------------------------------
  if (loading && isEmpty) {
    return (
      <SectionCard title={title} hint={hint}>
        <GeneratingLoader minHeight={200} />
      </SectionCard>
    );
  }

  // -- Empty (loaded, but no rows) ------------------------------------
  if (isEmpty) {
    return (
      <SectionCard title={title} hint={hint}>
        <div className="h-[120px] flex items-center justify-center text-gray-500 text-sm">
          Keine Daten vorhanden
        </div>
      </SectionCard>
    );
  }

  return <>{children}</>;
}
