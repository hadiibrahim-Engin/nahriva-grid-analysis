import { useRef, useState } from 'react';
import { useAnalysis } from '../hooks/useAnalysis';
import { useGridFilter } from '../hooks/useGridFilter';
import { downloadText } from '../util/csv';
import { pinnedViewUrl } from '../util/shareLink';

interface Bookmark { name: string; url: string; created: string }

const KEY = 'dashboardBookmarks';

const read = (): Bookmark[] => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isBookmark) : [];
  } catch {
    return [];
  }
};

function isBookmark(value: unknown): value is Bookmark {
  const b = value as Bookmark;
  return !!b && typeof b.name === 'string' && typeof b.url === 'string' && typeof b.created === 'string'
    && b.url.startsWith(window.location.origin);
}

/**
 * Named views of the dashboard (analysis pinned, grid, voltage level, scenario), kept in this browser. Each one is a
 * link that can be copied, and the whole list can be saved to a file and read back, e.g. by a colleague.
 */
export default function Bookmarks() {
  const dialog = useRef<HTMLDialogElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const { analysis } = useAnalysis();
  const { grid, kv } = useGridFilter();
  const [items, setItems] = useState<Bookmark[]>([]);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');

  const store = (next: Bookmark[]) => {
    setItems(next);
    try { window.localStorage.setItem(KEY, JSON.stringify(next)); } catch { setNote('This browser keeps no bookmarks.'); }
  };
  const open = () => { setItems(read()); setNote(''); dialog.current?.showModal(); };
  const save = async () => {
    const label = name.trim();
    if (!label) return;
    const url = await pinnedViewUrl(analysis, grid, kv);
    store([{ name: label, url, created: new Date().toISOString() }, ...items.filter((b) => b.name !== label)]);
    setName('');
    setNote(`Saved “${label}”.`);
  };
  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); setNote('Link copied.'); } catch { window.prompt('Copy this link', url); }
  };
  const load = async (picked: File) => {
    try {
      const parsed: unknown = JSON.parse(await picked.text());
      const incoming = (Array.isArray(parsed) ? parsed : []).filter(isBookmark);
      const names = new Set(incoming.map((b) => b.name));
      store([...incoming, ...items.filter((b) => !names.has(b.name))]);
      setNote(`${incoming.length} bookmark(s) read.`);
    } catch {
      setNote('The file holds no bookmarks of this dashboard.');
    }
  };

  return (
    <>
      <button type="button" className="ab-chip" onClick={open} title="Named views: save, open, share">Bookmarks</button>
      <dialog ref={dialog} className="ab-dialog" aria-label="Bookmarks">
        <div className="ab-dialog__head">
          <h3 className="across-card__title">Bookmarks</h3>
          <button type="button" className="ab-chip" onClick={() => dialog.current?.close()}>Close</button>
        </div>
        <form className="ab-chips" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <input className="ab-control" placeholder="Name of the current view" aria-label="Bookmark name" value={name}
            onChange={(e) => setName(e.target.value)} style={{ minWidth: '16rem' }} />
          <button type="submit" className="ab-chip" disabled={!name.trim()}>Save current view</button>
        </form>
        {items.length === 0 ? <p className="ab-empty">No bookmarks yet.</p> : (
          <div className="ab-scroll mt-2">
            <table className="ab-table">
              <thead><tr><th>Name</th><th>Saved</th><th /></tr></thead>
              <tbody>
                {items.map((b) => (
                  <tr key={b.name}>
                    <td>{b.name}</td>
                    <td>{new Date(b.created).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}</td>
                    <td className="ab-chips">
                      <button type="button" className="ab-chip" onClick={() => window.location.assign(b.url)}>Open</button>
                      <button type="button" className="ab-chip" onClick={() => { void copy(b.url); }}>Copy link</button>
                      <button type="button" className="ab-chip" onClick={() => store(items.filter((x) => x !== b))}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="ab-dialog__actions">
          {note && <span className="ab-sub" role="status">{note}</span>}
          <button type="button" className="ab-chip" onClick={() => file.current?.click()}>Read from file</button>
          <button type="button" className="ab-chip" disabled={items.length === 0}
            onClick={() => downloadText('dashboard-bookmarks.json', JSON.stringify(items, null, 2), 'application/json')}>Save to file</button>
          <input ref={file} type="file" accept="application/json,.json" hidden
            onChange={(e) => { const picked = e.target.files?.[0]; if (picked) void load(picked); e.target.value = ''; }} />
        </div>
      </dialog>
    </>
  );
}
