import { useEffect, useRef, useState } from 'react';
import { Share2 } from 'lucide-react';
import AnimatedButton from './ui/AnimatedButton';
import { createShare } from '../api/client';
import {
  buildShareLink,
  saveLastShareLink,
  copyShareLinkToClipboard,
  writeClipboardDeferred,
  type SharedView,
} from '../util/shareView';
import { logError } from '../debug/debugLog';

interface ShareButtonProps {
  view: SharedView;
}

type Status = 'idle' | 'pending' | 'ok' | 'err';

/**
 * Creates a server-side share link and shows it so the user can always grab
 * it — auto-copy to the clipboard is attempted but not relied on, since
 * browsers frequently block it (see writeClipboardDeferred for why).
 */
export default function ShareButton({ view }: ShareButtonProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [link, setLink] = useState<string | null>(null);
  const [autoCopied, setAutoCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status !== 'ok') return;
    inputRef.current?.select();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setStatus('idle');
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setStatus('idle');
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [status]);

  function handleClick() {
    if (status === 'pending') return;
    setStatus('pending');
    setAutoCopied(false);

    const urlPromise = createShare('live', { view }).then((id) => {
      const url = buildShareLink(id);
      saveLastShareLink(url);
      return url;
    });

    // Fire synchronously (no preceding await) so the clipboard permission
    // check stays tied to this click, even though the URL resolves later.
    writeClipboardDeferred(urlPromise).then(setAutoCopied);

    urlPromise
      .then((url) => {
        setLink(url);
        setStatus('ok');
      })
      .catch((err) => {
        logError('Share', 'Teilen fehlgeschlagen', String(err));
        setStatus('err');
        setTimeout(() => setStatus('idle'), 2500);
      });
  }

  async function handleManualCopy() {
    if (!link) return;
    // A direct click — always inside a fresh user gesture, so this reliably works.
    const copied = await copyShareLinkToClipboard(link);
    setAutoCopied(copied);
    inputRef.current?.select();
  }

  return (
    <div ref={rootRef} className="relative">
      <AnimatedButton
        variant={status === 'err' ? 'danger' : 'primary'}
        size="sm"
        onClick={handleClick}
        disabled={status === 'pending'}
        loading={status === 'pending'}
        title="Aktuelle Ansicht als Link speichern"
        icon={status === 'err' ? <span aria-hidden>✕</span> : <Share2 size={14} strokeWidth={2.2} />}
      >
        {status === 'err' ? 'Fehler' : 'Teilen'}
      </AnimatedButton>

      {status === 'ok' && link && (
        <div
          role="dialog"
          aria-label="Geteilter Link"
          className="absolute right-0 top-9 z-[1000] w-80 overflow-hidden rounded-xl border shadow-2xl"
          style={{ background: 'var(--grid-surface)', borderColor: 'var(--grid-border)', color: 'var(--grid-text)' }}
        >
          <div
            className="px-3 py-2 text-xs font-semibold"
            style={{ borderBottom: '1px solid var(--grid-border)', color: 'var(--grid-muted)' }}
          >
            {autoCopied ? 'Link in Zwischenablage kopiert' : 'Link erstellt — manuell kopieren:'}
          </div>
          <div className="flex items-center gap-2 px-3 py-3">
            <input
              ref={inputRef}
              readOnly
              value={link}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1.5 text-xs"
              style={{ borderColor: 'var(--grid-border)', color: 'var(--grid-text)' }}
            />
            <AnimatedButton variant="secondary" size="xs" onClick={handleManualCopy}>
              Kopieren
            </AnimatedButton>
          </div>
        </div>
      )}
    </div>
  );
}
