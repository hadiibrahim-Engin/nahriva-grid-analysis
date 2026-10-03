// Console logging for unexpected states (grouped and collapsed, so the console stays readable).

type LogLevel = 'info' | 'warn' | 'error';

const STYLES: Record<LogLevel, string> = {
  info: 'color:#6b7280',
  warn: 'color:#f59e0b',
  error: 'color:#ef4444;font-weight:bold',
};

function write(level: LogLevel, source: string, message: string, detail?: string, meta?: Record<string, unknown>) {
  console.groupCollapsed(`%c[${level.toUpperCase()}] ${source}: ${message}`, STYLES[level]);
  if (detail) console.log(detail);
  if (meta) console.log(meta);
  console.groupEnd();
}

export function logInfo(source: string, message: string, meta?: Record<string, unknown>) {
  write('info', source, message, undefined, meta);
}

export function logError(source: string, message: string, detail?: string, meta?: Record<string, unknown>) {
  write('error', source, message, detail, meta);
}
