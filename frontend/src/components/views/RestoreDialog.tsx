import { useRef, useState } from 'react';
import { views, utc } from '../../api/views';
import { downloadText, fileSafe } from '../../util/csv';

/**
 * Hands a scenario (and optionally one time) over to PowerFactory as a checkable JSON package. The dashboard only
 * collects the facts; rebuilding and recalculating is PowerFactory's job. The limitations come first, so the
 * package is never taken for more than it is.
 */
export default function RestoreDialog({ scenarioId, label, t = null }: { scenarioId: string; label: string; t?: number | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState('');
  const [limitations, setLimitations] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const open = async () => {
    setError(''); setText(''); setNote('');
    dialog.current?.showModal();
    try {
      const pkg = await views.restorePackage(scenarioId, t);
      setLimitations(Array.isArray(pkg.limitations) ? (pkg.limitations as string[]) : []);
      setText(JSON.stringify(pkg, null, 2));
    } catch {
      setError('The restore package could not be loaded.');
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setNote('Copied');
    } catch {
      setNote('Copy failed: use Download');
    }
  };
  const name = `restore-${fileSafe(label)}${t === null ? '' : `-${t}`}.json`;

  return (
    <>
      <button type="button" className="ab-chip" onClick={() => { void open(); }}
        title="The facts PowerFactory needs to rebuild this scenario, as JSON">
        Restore package{t === null ? '' : ` · ${utc(t)}`}
      </button>
      <dialog ref={dialog} className="ab-dialog" aria-label={`Restore package of ${label}`}>
        <div className="ab-dialog__head">
          <h3 className="across-card__title">PowerFactory restore package · {label}{t === null ? '' : ` · ${utc(t)} UTC`}</h3>
          <button type="button" className="ab-chip" onClick={() => dialog.current?.close()} aria-label="Close">Close</button>
        </div>
        {error && <p role="alert" className="ab-empty">{error}</p>}
        {!text && !error && <p className="ab-empty" aria-busy>Loading …</p>}
        {limitations.length > 0 && (
          <ul className="ab-dialog__limits" aria-label="Limitations">
            {limitations.map((item) => <li key={item}>{item}</li>)}
          </ul>
        )}
        {text && <pre className="ab-dialog__json">{text}</pre>}
        <div className="ab-dialog__actions">
          {note && <span className="ab-sub" role="status">{note}</span>}
          <button type="button" className="ab-chip" disabled={!text} onClick={() => { void copy(); }}>Copy</button>
          <button type="button" className="ab-chip" disabled={!text} onClick={() => downloadText(name, text, 'application/json')}>Download</button>
        </div>
      </dialog>
    </>
  );
}
