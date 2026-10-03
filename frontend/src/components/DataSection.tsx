import type { ReactNode } from 'react';
import InfoHint from './InfoHint';
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

function Title({ title, hint, className }: { title: string; hint?: string; className: string }) {
  return (
    <h2 className={`inline-flex items-center gap-1 ${className}`}>
      <span>{title}</span>
      {hint && <InfoHint text={hint} />}
    </h2>
  );
}


export default function DataSection({ title, hint, loading, error, isEmpty, children }: Props) {
  if (error) {
    return (
      <div className="bg-gray-800 rounded-lg p-4 border border-red-800/60">
        <Title title={title} hint={hint} className="text-sm text-red-400 mb-2" />
        <div className="flex items-start gap-3 py-3 px-4 bg-red-900/20 rounded border border-red-800/40">
          <span className="text-red-400 text-xl shrink-0">⚠</span>
          <div>
            <div className="text-sm text-red-300 font-semibold">{title} konnte nicht angezeigt werden</div>
            <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-red-300/80">Ursache</div>
            <div className="text-xs text-red-400/80 mt-1 font-mono whitespace-pre-wrap">{error}</div>
          </div>
        </div>
      </div>
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
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <Title title={title} hint={hint} className="text-sm text-gray-400 mb-3" />
        <GeneratingLoader minHeight={200} />
      </div>
    );
  }

  // -- Empty (loaded, but no rows) ------------------------------------
  if (isEmpty) {
    return (
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <Title title={title} hint={hint} className="text-sm text-gray-400 mb-2" />
        <div className="h-[120px] flex items-center justify-center text-gray-500 text-sm">
          Keine Daten vorhanden
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
