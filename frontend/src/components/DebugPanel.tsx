import { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { Wrench } from 'lucide-react';
import { getEntries, clearEntries, subscribe, type DebugEntry, type LogLevel } from '../debug/debugLog';
import { useFloatingPanel } from '../util/floatingPanels';
import AnimatedButton from './ui/AnimatedButton';

const LEVEL_STYLES: Record<LogLevel, { bg: string; text: string; badge: string }> = {
  error: { bg: 'bg-red-900/40', text: 'text-red-300', badge: 'bg-red-600' },
  warn: { bg: 'bg-yellow-900/30', text: 'text-yellow-300', badge: 'bg-yellow-600' },
  info: { bg: 'bg-gray-800', text: 'text-gray-400', badge: 'bg-gray-600' },
};

function formatTime(d: Date) {
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function EntryRow({ entry, isExpanded, onToggle }: { entry: DebugEntry; isExpanded: boolean; onToggle: () => void }) {
  const style = LEVEL_STYLES[entry.level];
  return (
    <div className={`${style.bg} border-b border-gray-700/50`}>
      <button onClick={onToggle} className="w-full text-left px-3 py-1.5 flex items-start gap-2 hover:bg-white/5 transition-colors">
        <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-bold uppercase ${style.badge} text-white mt-0.5`}>
          {entry.level}
        </span>
        <span className="text-[10px] text-gray-500 shrink-0 font-mono mt-0.5">{formatTime(entry.timestamp)}</span>
        <span className="text-xs text-gray-400 shrink-0">[{entry.source}]</span>
        <span className={`text-xs ${style.text} truncate`}>{entry.message}</span>
        <span className="ml-auto text-gray-600 text-xs shrink-0">{isExpanded ? '▾' : '▸'}</span>
      </button>
      {isExpanded && (
        <div className="px-3 pb-2 ml-8 space-y-1">
          {entry.detail && (
            <pre className="text-[11px] text-gray-300 whitespace-pre-wrap bg-black/30 rounded p-2 max-h-40 overflow-auto font-mono">
              {entry.detail}
            </pre>
          )}
          {entry.meta && (
            <pre className="text-[11px] text-gray-500 whitespace-pre-wrap bg-black/20 rounded p-2 max-h-40 overflow-auto font-mono">
              {JSON.stringify(entry.meta, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default function DebugPanel() {
  const entries = useSyncExternalStore(subscribe, getEntries);
  const { isOpen, open, close, toggle } = useFloatingPanel('debug');
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<LogLevel | 'all'>('all');
  const [search, setSearch] = useState('');
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const errorCount = entries.filter((e) => e.level === 'error').length;
  const warnCount = entries.filter((e) => e.level === 'warn').length;

  // Auto-open on first error
  const [lastSeenError, setLastSeenError] = useState(0);
  useEffect(() => {
    const firstError = entries.find((e) => e.level === 'error');
    if (firstError && firstError.id > lastSeenError) {
      setLastSeenError(firstError.id);
      open();
      setFilter('error');
    }
  }, [entries, lastSeenError, open]);

  const filtered = entries.filter((e) => {
    if (filter !== 'all' && e.level !== filter) return false;
    if (search && !(`${e.source} ${e.message} ${e.detail ?? ''}`).toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const toggleExpand = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(close, 180);
  };

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  return (
    <div
      className="fixed bottom-4 right-4 z-[950]"
      onPointerEnter={() => { cancelClose(); open(); }}
      onPointerLeave={scheduleClose}
      onFocus={() => { cancelClose(); open(); }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          scheduleClose();
        }
      }}
    >
      {/* Floating trigger button */}
      <div>
        <AnimatedButton
          variant="primary"
          size="sm"
          onClick={toggle}
          className={`w-[6rem] shadow-lg ${
            errorCount > 0
              ? 'border-[var(--grid-danger)] text-[var(--grid-danger)] animate-pulse'
              : warnCount > 0
                ? 'border-[var(--grid-warning)] text-[var(--grid-warning)]'
                : ''
          }`}
          title="Debug Panel öffnen"
          icon={<Wrench size={14} strokeWidth={2.2} />}
        >
          Debug
          {errorCount > 0 && <span className="bg-red-500 text-white text-[10px] px-1.5 rounded-full">{errorCount}</span>}
          {warnCount > 0 && <span className="bg-yellow-500 text-black text-[10px] px-1.5 rounded-full">{warnCount}</span>}
        </AnimatedButton>
      </div>

      {/* Panel */}
      {isOpen && (
        <div className="absolute bottom-10 right-0 w-[600px] max-h-[70vh] bg-gray-900 border border-gray-700 rounded-lg shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-2 bg-gray-800 border-b border-gray-700 shrink-0">
            <span className="text-sm font-bold text-white">Debug Log</span>
            <span className="text-[10px] text-gray-500 ml-1">{entries.length} Einträge</span>
            <div className="flex gap-1 ml-3">
              {(['all', 'error', 'warn', 'info'] as const).map((lvl) => (
                <button
                  key={lvl}
                  onClick={() => setFilter(lvl)}
                  className={`text-[10px] px-2 py-0.5 rounded transition-colors ${filter === lvl ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400 hover:text-white'}`}
                >
                  {lvl === 'all' ? 'Alle' : lvl.toUpperCase()}
                  {lvl === 'error' && errorCount > 0 && ` (${errorCount})`}
                  {lvl === 'warn' && warnCount > 0 && ` (${warnCount})`}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Suche..."
              className="ml-auto w-32 bg-gray-700 border border-gray-600 text-white text-[11px] px-2 py-0.5 rounded focus:outline-none focus:border-blue-500"
            />
            <button onClick={clearEntries} className="text-[10px] text-gray-500 hover:text-red-400 px-1" title="Alle löschen">✕ Clear</button>
            <button onClick={close} className="text-gray-500 hover:text-white text-sm px-1">✕</button>
          </div>

          {/* Entries */}
          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="p-4 text-center text-gray-500 text-xs">
                {entries.length === 0 ? 'Noch keine Einträge. API-Aufrufe werden hier protokolliert.' : 'Keine Treffer für Filter.'}
              </div>
            ) : (
              filtered.map((e) => (
                <EntryRow key={e.id} entry={e} isExpanded={expandedIds.has(e.id)} onToggle={() => toggleExpand(e.id)} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
