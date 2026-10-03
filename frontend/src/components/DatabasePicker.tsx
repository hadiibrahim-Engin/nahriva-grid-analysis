import { useRef, useState, type FormEvent } from 'react';
import api, { clearCache } from '../api/client';
import { clearLocalView } from '../util/shareView';
import AnimatedButton from './ui/AnimatedButton';

export default function DatabasePicker() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function open() {
    setError('');
    dialog.current?.showModal();
    try {
      const response = await api.get<{ path: string }>('/database');
      setPath(response.data.path);
    } catch {
      setError('Der aktuelle Datenbankpfad konnte nicht geladen werden.');
    }
  }

  async function select(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/database', { path });
      clearCache();
      clearLocalView();
      // A full reload also discards component state and any old shared-view URL.
      window.location.assign(window.location.pathname);
    } catch (failure) {
      const detail = (failure as { response?: { data?: { detail?: unknown } } }).response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'Die Datenbank konnte nicht geladen werden.');
      setBusy(false);
    }
  }

  return <>
    <AnimatedButton variant="secondary" onClick={open}>Datenbank hinzufügen</AnimatedButton>
    <dialog ref={dialog} aria-labelledby="database-dialog-title"
      onCancel={event => { if (busy) event.preventDefault(); }}
      className="grid-theme-scope fixed inset-0 m-auto w-[min(36rem,calc(100vw-2rem))] rounded-xl border border-[var(--grid-border)] bg-[var(--grid-surface)] p-6 text-[var(--grid-text)] shadow-xl backdrop:bg-black/40">
      <form onSubmit={select} className="space-y-4">
        <h2 id="database-dialog-title" className="text-lg font-semibold">Datenbank hinzufügen</h2>
        <p className="text-sm text-[var(--grid-muted)]">Absoluter Pfad der lokalen SQLite-Ergebnisdatenbank auf diesem Rechner bzw. der PowerFactory-VM.</p>
        <label className="block">
          <span className="grid-form-label">Datenbankpfad</span>
          <input autoFocus required value={path} onChange={event => setPath(event.target.value)}
            disabled={busy} className="grid-form-input w-full" placeholder="/…/outage-assessment.sqlite3" />
        </label>
        {error && <p role="alert" className="text-sm text-[var(--grid-danger)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <AnimatedButton variant="secondary" disabled={busy} onClick={() => dialog.current?.close()}>Abbrechen</AnimatedButton>
          <AnimatedButton type="submit" loading={busy} disabled={!path.trim()}>Datenbank laden</AnimatedButton>
        </div>
      </form>
    </dialog>
  </>;
}
