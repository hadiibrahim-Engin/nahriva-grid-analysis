import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Database } from 'lucide-react';
import api, { clearCache } from '../api/client';
import { clearLocalView, loadLocalView, saveLocalView, type SavedView } from '../util/savedView';
import { readOverrides, saveOverrides, sanitize } from '../config/overrides';
import { useAnalysis } from '../hooks/useAnalysis';
import AnimatedButton from './ui/AnimatedButton';

export default function DatabasePicker() {
  const dialog = useRef<HTMLDialogElement>(null);
  const { analysis } = useAnalysis();
  const [mode, setMode] = useState<'database' | 'export' | 'import'>('database');
  const [archive, setArchive] = useState('');
  const [destination, setDestination] = useState('');
  const [message, setMessage] = useState('');
  const [parquet, setParquet] = useState(false);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // In network operation the database is fixed by the server; switching is only offered where it is allowed.
  const [allowed, setAllowed] = useState(true);
  useEffect(() => {
    api.get<{ database_switch?: boolean; parquet_archive?: boolean }>('/capabilities')
      .then((response) => { setAllowed(response.data.database_switch !== false); setParquet(response.data.parquet_archive === true); })
      .catch(() => undefined);
  }, []);

  async function open() {
    setError('');
    setMessage('');
    dialog.current?.showModal();
    try {
      const response = await api.get<{ path: string }>('/database');
      setPath(response.data.path);
    } catch {
      setError('The current database path could not be loaded.');
    }
  }

  async function select(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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

  if (!allowed) return null;
  return <>
    <button type="button" className="db-circle" onClick={open} aria-label="Open or save datasets" aria-haspopup="dialog" title="Open or save datasets">
      <Database size={18} strokeWidth={1.9} aria-hidden />
      <span className="db-circle__plus" aria-hidden>+</span>
    </button>
    <dialog ref={dialog} aria-labelledby="database-dialog-title"
      onCancel={event => { if (busy) event.preventDefault(); }}
      className="grid-theme-scope fixed inset-0 m-auto w-[min(36rem,calc(100vw-2rem))] rounded-xl border border-[var(--grid-border)] bg-[var(--grid-surface)] p-6 text-[var(--grid-text)] shadow-xl backdrop:bg-black/40">
      <form onSubmit={select} className="space-y-4">
        <h2 id="database-dialog-title" className="text-lg font-semibold">Open or save datasets</h2>
        <div className="flex flex-wrap gap-2">
          {(['database', 'export', 'import'] as const).map(value => <button key={value} type="button"
            className="grid-form-input" aria-pressed={mode === value} disabled={busy || (value !== 'database' && !parquet)}
            onClick={() => { setMode(value); setError(''); setMessage(''); }}>
            {value === 'database' ? 'Open SQLite' : value === 'export' ? 'Save Parquet' : 'Reopen Parquet'}
          </button>)}
        </div>
        {!parquet && <p className="text-sm text-[var(--grid-muted)]">Parquet support requires installing the backend archive extra: pip install "./backend[archive]".</p>}
        <p className="text-sm text-[var(--grid-muted)]">{mode === 'export'
          ? 'Save the selected complete analysis, results, settings and current view to a Parquet archive folder on the dashboard server.'
          : mode === 'import' ? 'Reopen a saved archive folder into a new SQLite database on the dashboard server. Existing files are never overwritten.'
          : 'Absolute path of the local SQLite results database on this PC or on the PowerFactory VM.'}</p>
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
        {mode !== 'export' &&
        <label className="block">
          <span className="grid-form-label">{mode === 'import' ? 'New restored database path' : 'Database path'}</span>
          <input autoFocus required value={path} onChange={event => setPath(event.target.value)}
            disabled={busy} className="grid-form-input w-full" placeholder="/…/outage-assessment.sqlite3" />
        </label>}
        {message && <p role="status" className="text-sm">{message}</p>}
        {busy && mode !== 'database' && <p role="status" className="text-sm">Streaming and validating data. Large analyses may take several minutes.</p>}
        {error && <p role="alert" className="text-sm text-[var(--grid-danger)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <AnimatedButton variant="secondary" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</AnimatedButton>
          <AnimatedButton type="submit" loading={busy} disabled={mode === 'export' ? !destination.trim() : !path.trim() || (mode === 'import' && !archive.trim())}>{mode === 'export' ? 'Save archive' : mode === 'import' ? 'Restore and open' : 'Load database'}</AnimatedButton>
        </div>
      </form>
    </dialog>
  </>;
}
