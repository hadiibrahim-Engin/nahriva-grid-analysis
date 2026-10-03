import { Component, type ReactNode } from 'react';
import { logError } from '../debug/debugLog';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  label?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
}

const MODULE_RELOAD_KEY = 'grid-monitor:module-import-reload-at';
const MODULE_RELOAD_WINDOW_MS = 10_000;

function isModuleImportFailure(error: Error | null): boolean {
  const message = error?.message ?? '';
  return (
    message.includes('Importing a module script failed') ||
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('error loading dynamically imported module') ||
    message.includes('Load failed')
  );
}

function shouldAutoReloadForModuleFailure(): boolean {
  if (typeof window === 'undefined') return false;
  const lastAttempt = Number(window.sessionStorage.getItem(MODULE_RELOAD_KEY) ?? 0);
  return !Number.isFinite(lastAttempt) || Date.now() - lastAttempt > MODULE_RELOAD_WINDOW_MS;
}

function markModuleFailureReloadAttempt() {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(MODULE_RELOAD_KEY, String(Date.now()));
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    this.setState({ componentStack: info.componentStack });
    const label = this.props.label ?? 'Chart';
    logError('ErrorBoundary', `${label}: ${error.message}`, `${error.stack ?? ''}\n\nComponent Stack:${info.componentStack}`);
    if (isModuleImportFailure(error) && shouldAutoReloadForModuleFailure()) {
      markModuleFailureReloadAttempt();
      window.location.reload();
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      const { error, componentStack } = this.state;
      const label = this.props.label?.trim() || 'This section';
      const message = error?.message || 'Unknown error';
      const moduleImportFailure = isModuleImportFailure(error);
      return (
        <div
          role="alert"
          className="h-[400px] flex flex-col items-center justify-center gap-3 rounded border-2 border-red-500/70 bg-red-950/30 p-5 text-center shadow-[0_0_0_1px_rgba(239,68,68,0.2)]"
        >
          <div className="rounded bg-red-500 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-white">
            Not shown
          </div>
          <div className="text-lg font-bold text-red-200">{label} could not be displayed</div>
          <div className="w-full max-w-xl rounded border border-red-800/60 bg-black/30 px-3 py-2 text-left">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-red-300">Cause</div>
            <div className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-red-200">{message}</div>
          </div>
          {moduleImportFailure && (
            <div className="max-w-xl rounded border border-yellow-700/60 bg-yellow-900/20 px-3 py-2 text-left text-xs text-yellow-100">
              A JavaScript module could not be loaded. The app reloads the page once automatically. If this notice stays: close old Vite tabs, use only one dev server and reload this page.
            </div>
          )}
          {componentStack && (
            <details className="mt-2 w-full max-w-lg">
              <summary className="text-xs text-red-300/80 cursor-pointer hover:text-red-200">
                Show stack trace
              </summary>
              <pre className="mt-1 text-[10px] text-gray-400 whitespace-pre-wrap max-h-48 overflow-auto bg-black/40 rounded p-2 font-mono text-left">
                {error?.stack}
                {'\n--- Component Stack ---'}
                {componentStack}
              </pre>
            </details>
          )}
          <button
            className="mt-1 rounded bg-red-700 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-600"
            onClick={() => {
              if (moduleImportFailure) {
                window.location.reload();
                return;
              }
              this.setState({ hasError: false, error: null, componentStack: null });
            }}
          >
            {moduleImportFailure ? 'Reload page' : 'Try again'}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
