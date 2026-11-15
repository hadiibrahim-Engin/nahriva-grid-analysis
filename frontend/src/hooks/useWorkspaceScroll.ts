import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { isWorkspaceId, type WorkspaceId } from '../util/workspaces';

/** Follow the actual scroll container, including layout changes as deferred sections mount. */
export function useWorkspaceScroll(rootRef: RefObject<HTMLDivElement | null>, initial: WorkspaceId, onActive: (id: WorkspaceId) => void) {
  const pending = useRef<WorkspaceId | null>(initial === 'assessment' ? null : initial);
  const navigate = useCallback((id: WorkspaceId) => {
    const root = rootRef.current;
    const target = root?.querySelector<HTMLElement>(`[data-workspace="${id}"]`);
    if (!root || !target) { pending.current = id; return; }
    pending.current = id;
    root.scrollTo({ top: root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top, behavior: 'instant' });
  }, [rootRef]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let frame = 0;
    let last: WorkspaceId | null = null;
    const resize = new ResizeObserver(() => schedule());
    const update = () => {
      frame = 0;
      const sections = [...root.querySelectorAll<HTMLElement>('[data-workspace]')];
      for (const section of sections) resize.observe(section);
      if (pending.current) {
        const target = sections.find((s) => s.dataset.workspace === pending.current);
        if (target) {
          // Deferred content above the destination may grow after a jump. Keep its heading aligned until
          // the next deliberate scroll/pointer/key input, rather than landing in the preceding section.
          const delta = target.getBoundingClientRect().top - root.getBoundingClientRect().top;
          if (Math.abs(delta) > 1) root.scrollTo({ top: root.scrollTop + delta, behavior: 'instant' });
        } else return;
      }
      const line = root.getBoundingClientRect().top + Math.min(96, root.clientHeight * .2);
      let active = sections[0]?.dataset.workspace;
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= line) active = section.dataset.workspace;
      }
      if (root.scrollHeight > root.clientHeight && root.scrollHeight - root.scrollTop - root.clientHeight < 2) {
        active = sections.at(-1)?.dataset.workspace;
      }
      if (isWorkspaceId(active ?? null) && active !== last) {
        last = active as WorkspaceId;
        onActive(last);
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const releaseJump = (event: Event) => {
      if (event.target instanceof Node && root.contains(event.target)) pending.current = null;
    };
    const releaseKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) pending.current = null;
    };
    // Window capture runs before chart wheel handlers; those may stop propagation to keep Ctrl for zoom.
    window.addEventListener('wheel', releaseJump, { capture: true, passive: true });
    window.addEventListener('touchstart', releaseJump, { capture: true, passive: true });
    window.addEventListener('pointerdown', releaseJump, { capture: true, passive: true });
    window.addEventListener('keydown', releaseKey, true);
    const mutations = new MutationObserver(schedule);
    mutations.observe(root, { subtree: true, childList: true });
    resize.observe(root);
    root.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      mutations.disconnect();
      resize.disconnect();
      root.removeEventListener('scroll', schedule);
      window.removeEventListener('wheel', releaseJump, true);
      window.removeEventListener('touchstart', releaseJump, true);
      window.removeEventListener('pointerdown', releaseJump, true);
      window.removeEventListener('keydown', releaseKey, true);
    };
  }, [rootRef, onActive]);
  return navigate;
}
