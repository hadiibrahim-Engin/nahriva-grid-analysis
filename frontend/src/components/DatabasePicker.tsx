import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Database } from 'lucide-react';
import api, { clearCache } from '../api/client';
import { clearLocalView, loadLocalView, saveLocalView, type SavedView } from '../util/savedView';
import { readOverrides, saveOverrides, sanitize } from '../config/overrides';
import { useAnalysis } from '../hooks/useAnalysis';
import AnimatedButton from './ui/AnimatedButton';
import DatabaseContents, { type DatabaseInventory } from './DatabaseContents';

export default function DatabasePicker({ refreshKey = 0 }: { refreshKey?: number }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { analysis, setAnalysis } = useAnalysis();
  const [contents, setContents] = useState<DatabaseInventory | null>(null);
  const [contentsLoading, setContentsLoading] = useState(false);
  const contentsRequest = useRef<AbortController | null>(null);
  const [mode, setMode] = useState<'contents' | 'database' | 'export' | 'import'>('contents');
  const [archive, setArchive] = useState('');
  const [destination, setDestination] = useState('');
  const [message, setMessage] = useState('');
  const [parquet, setParquet] = useState(false);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // In network operation the database is fixed by the server; switching is only offered where it is allowed.
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    let active = true;
    api.get<{ database_switch?: boolean; parquet_archive?: boolean }>('/capabilities')
      .then((response) => { if (active) { setAllowed(response.data.database_switch !== false); setParquet(response.data.parquet_archive === true); } })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const loadContents = useCallback(async () => {
    contentsRequest.current?.abort();
    const controller = new AbortController();
    contentsRequest.current = controller;
    setContentsLoading(true);
    setError('');
    try {
      const response = await api.get<DatabaseInventory>('/database/contents', { signal: controller.signal });
      if (!controller.signal.aborted) { setContents(response.data); setPath(response.data.path); }
    } catch {
      if (!controller.signal.aborted) setError('The database contents could not be loaded.');
    } finally {
      if (!controller.signal.aborted) setContentsLoading(false);
    }
  }, []);
  useEffect(() => {
    if (dialog.current?.open && mode === 'contents') void loadContents();
    return () => contentsRequest.current?.abort();
  }, [refreshKey, loadContents, mode]);
  useEffect(() => () => contentsRequest.current?.abort(), []);

  function open() {
    setMode('contents');
    setContents(null);
    setError('');
    setMessage('');
    dialog.current?.showModal();
    void loadContents();
  }

  async function select(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === 'contents') return;
    setBusy(true);
    setError('');
    try {
      if (mode === 'export') {
        const result = await api.post<{ path: string }>('/archives/export', {
          directory: destination, analysis,
          context: { view: loadLocalView(), query: window.location.search, limits: readOverrides() },
        }, { timeout: 0 });
        setMessage(`Saved and verified: ${result.data.path}. Keep this entire folder, including manifest.json.`);
        setBusy(false);
        return;
      }
      let query = '';
      let view: SavedView | null = null;
      if (mode === 'import') {
        const result = await api.post<{ analysis_id: string; context?: { view?: SavedView; query?: string; limits?: unknown } }>(
          '/archives/import', { archive, database: path }, { timeout: 0 });
        const context = result.data.context;
        if (context?.view?.v === 1 && Array.isArray(context.view.series) && Array.isArray(context.view.charts)) view = context.view;
        const params = new URLSearchParams(typeof context?.query === 'string' ? context.query : '');
        params.set('analysis', result.data.analysis_id);
        query = `?${params.toString()}`;
        if (context?.limits) {
          try { saveOverrides(sanitize(context.limits)); } catch { /* view restoration is best-effort in privacy mode */ }
        }
      } else {
        await api.post('/database', { path });
      }
      clearCache();
      clearLocalView();
      if (view) saveLocalView(view);
      // A full reload also discards component state and any old shared-view URL.
      window.location.assign(window.location.pathname + query);
    } catch (failure) {
      const detail = (failure as { response?: { data?: { detail?: unknown } } }).response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'The operation could not be completed.');
      setBusy(false);
    }
  }

  return <>
    <button type="button" className="ab-chip inline-flex items-center gap-2" onClick={open} aria-label="Show database contents" aria-haspopup="dialog" title="Calculations, cases and results in this database">
      <Database size={18} strokeWidth={1.9} aria-hidden />
      Database contents
    </button>
    <dialog ref={dialog} aria-labelledby="database-dialog-title"
      onCancel={event => { if (busy) event.preventDefault(); }}
      onClose={() => contentsRequest.current?.abort()}
      className={`grid-theme-scope fixed inset-0 m-auto max-h-[calc(100vh-2rem)] overflow-y-auto ${mode === 'contents' ? 'w-[min(72rem,calc(100vw-2rem))]' : 'w-[min(36rem,calc(100vw-2rem))]'} rounded-xl border border-[var(--grid-border)] bg-[var(--grid-surface)] p-6 text-[var(--grid-text)] shadow-xl backdrop:bg-black/40`}>
      <form onSubmit={select} className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id="database-dialog-title" className="text-lg font-semibold">{mode === 'contents' ? 'Database contents' : 'Open or save datasets'}</h2>
          {mode === 'contents' && <button type="button" className="ab-chip" disabled={contentsLoading} onClick={() => void loadContents()}>Refresh contents</button>}
        </div>
        <div className="flex flex-wrap gap-2">
          {(['contents', ...(allowed ? ['database', 'export', 'import'] as const : [])] as const).map(value => <button key={value} type="button"
            className="grid-form-input" aria-pressed={mode === value} disabled={busy || (value !== 'database' && value !== 'contents' && !parquet)}
            onClick={() => { setMode(value); setError(''); setMessage(''); }}>
            {value === 'contents' ? 'Contents' : value === 'database' ? 'Open SQLite' : value === 'export' ? 'Save Parquet' : 'Reopen Parquet'}
          </button>)}
        </div>
        {mode !== 'contents' && !parquet && <p className="text-sm text-[var(--grid-muted)]">Parquet support requires installing the backend archive extra: pip install "./backend[archive]".</p>}
        {mode !== 'contents' && <p className="text-sm text-[var(--grid-muted)]">{mode === 'export'
          ? 'Save the selected complete analysis, results, settings and current view to a Parquet archive folder on the dashboard server.'
          : mode === 'import' ? 'Reopen a saved archive folder into a new SQLite database on the dashboard server. Existing files are never overwritten.'
          : 'Absolute path of the local SQLite results database on this PC or on the PowerFactory VM.'}</p>}
        {mode === 'export' && <label className="block">
          <span className="grid-form-label">Archive parent folder</span>
          <input required value={destination} onChange={event => setDestination(event.target.value)} disabled={busy}
            className="grid-form-input w-full" placeholder="/…/saved-analyses" />
        </label>}
        {mode === 'import' && <label className="block">
          <span className="grid-form-label">Saved archive folder (contains manifest.json)</span>
          <input required value={archive} onChange={event => setArchive(event.target.value)} disabled={busy}
            className="grid-form-input w-full" placeholder="/…/saved-analyses/analysis-id" />
        </label>}
        {mode !== 'export' && mode !== 'contents' &&
        <label className="block">
          <span className="grid-form-label">{mode === 'import' ? 'New restored database path' : 'Database path'}</span>
          <input autoFocus required value={path} onChange={event => setPath(event.target.value)}
            disabled={busy} className="grid-form-input w-full" placeholder="/…/outage-assessment.sqlite3" />
        </label>}
        {mode === 'contents' && contentsLoading && <p role="status">Loading database contents …</p>}
        {mode === 'contents' && contents && <DatabaseContents data={contents} selected={analysis} onSelect={(id) => {
          setAnalysis(id); dialog.current?.close();
        }} />}
        {message && <p role="status" className="text-sm">{message}</p>}
        {busy && mode !== 'database' && <p role="status" className="text-sm">Streaming and validating data. Large analyses may take several minutes.</p>}
        {error && <p role="alert" className="text-sm text-[var(--grid-danger)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <AnimatedButton variant="secondary" disabled={busy} onClick={() => dialog.current?.close()}>{mode === 'contents' ? 'Close' : 'Cancel'}</AnimatedButton>
          {mode !== 'contents' && <AnimatedButton type="submit" loading={busy} disabled={mode === 'export' ? !destination.trim() : !path.trim() || (mode === 'import' && !archive.trim())}>{mode === 'export' ? 'Save archive' : mode === 'import' ? 'Restore and open' : 'Load database'}</AnimatedButton>}
        </div>
      </form>
    </dialog>
  </>;
}
