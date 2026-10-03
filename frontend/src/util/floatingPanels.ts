import { useCallback, useSyncExternalStore } from 'react';

/**
 * Coordinates the bottom-right floating panels (Debug, System Analytics, Help)
 * so at most one is open at a time: activating one closes the others. The state
 * is a single module-level "active panel id" the panels share, since they live
 * in different parts of the tree (App vs. DashboardPage) and can't lift it into
 * common component state.
 */
export type FloatingPanelId = 'debug' | 'system' | 'help';

type Listener = () => void;

let activeId: FloatingPanelId | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): FloatingPanelId | null {
  return activeId;
}

/** Set the active panel (or null). Notifies all panels so others close. */
export function setActivePanel(id: FloatingPanelId | null): void {
  if (activeId === id) return;
  activeId = id;
  emit();
}

/** Close only the requested panel; leave a newer active panel untouched. */
export function closeActivePanel(id: FloatingPanelId): void {
  if (activeId !== id) return;
  setActivePanel(null);
}

/** Read the active panel id reactively. */
export function useActivePanel(): FloatingPanelId | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Disclosure helper for a simple toggle panel. `isOpen` is true only while this
 * panel is the active one; opening it implicitly closes any other.
 */
export function useFloatingPanel(id: FloatingPanelId) {
  const active = useActivePanel();
  return {
    isOpen: active === id,
    open: useCallback(() => setActivePanel(id), [id]),
    close: useCallback(() => closeActivePanel(id), [id]),
    toggle: useCallback(() => setActivePanel(activeId === id ? null : id), [id]),
  };
}
