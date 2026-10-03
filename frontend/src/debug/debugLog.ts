export type LogLevel = 'info' | 'warn' | 'error';

export interface DebugEntry {
  id: number;
  timestamp: Date;
  level: LogLevel;
  source: string;
  message: string;
  detail?: string;
  meta?: Record<string, unknown>;
}

type Listener = () => void;

const MAX_ENTRIES = 200;
let nextId = 1;
const entries: DebugEntry[] = [];
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((fn) => fn());
}

export function addEntry(level: LogLevel, source: string, message: string, detail?: string, meta?: Record<string, unknown>) {
  const entry: DebugEntry = { id: nextId++, timestamp: new Date(), level, source, message, detail, meta };
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;

  const style = level === 'error' ? 'color:#ef4444;font-weight:bold' : level === 'warn' ? 'color:#f59e0b' : 'color:#6b7280';
  console.groupCollapsed(`%c[${level.toUpperCase()}] ${source}: ${message}`, style);
  if (detail) console.log(detail);
  if (meta) console.log(meta);
  console.groupEnd();

  notify();
}

export function logInfo(source: string, message: string, meta?: Record<string, unknown>) {
  addEntry('info', source, message, undefined, meta);
}

export function logWarn(source: string, message: string, detail?: string, meta?: Record<string, unknown>) {
  addEntry('warn', source, message, detail, meta);
}

export function logError(source: string, message: string, detail?: string, meta?: Record<string, unknown>) {
  addEntry('error', source, message, detail, meta);
}

export function getEntries(): readonly DebugEntry[] {
  return entries;
}

export function clearEntries() {
  entries.length = 0;
  nextId = 1;
  notify();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDebugEntries(): readonly DebugEntry[] {
  // This is imported separately by the React hook to avoid React dependency here
  return entries;
}
