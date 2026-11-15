import { useState } from 'react';
import { useAnalysis } from '../hooks/useAnalysis';
import { useGridFilter } from '../hooks/useGridFilter';
import { pinnedViewUrl } from '../util/shareLink';

/**
 * Copies a link to the current view. The analysis is always pinned (the newest one is resolved first), so the
 * link keeps showing the same results after a later PowerFactory run.
 */
export default function ShareLink() {
  const { analysis } = useAnalysis();
  const { grid, kv } = useGridFilter();
  const [note, setNote] = useState('');

  const copy = async () => {
    try {
      const url = await pinnedViewUrl(analysis, grid, kv);
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
        setNote('Link copied');
      } else {
        // Opened through a network address the browser keeps the clipboard closed: show the link to copy by hand.
        window.prompt('Copy this link', url);
      }
    } catch {
      setNote('Copy failed');
    }
    window.setTimeout(() => setNote(''), 2500);
  };

  return (
    <button type="button" className="ab-chip" onClick={() => { void copy(); }} title="Copy a link to this analysis, grid and voltage level">
      {note || 'Copy link'}
    </button>
  );
}
