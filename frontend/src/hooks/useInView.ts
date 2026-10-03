import { useCallback, useRef, useState } from 'react';

interface Options {
  /** CSS margin around the root that expands the intersection box.
   *  Default fires slightly before the section actually scrolls into view. */
  rootMargin?: string;
  /** Stop observing after the first time the section becomes visible.
   *  This is what we want for lazy-loading: fetch once, keep showing. */
  once?: boolean;
}

/**
 * Return a callback ref + boolean for "is this element in (or near) the viewport".
 *
 * Uses a callback ref (not a ref object) so the observer attaches when the
 * element actually mounts. Critical for conditionally-rendered subtrees like
 * tabs: a useEffect with a ref object only runs once and would miss the
 * element that mounts after a later tab switch.
 */
export function useInView<T extends Element = HTMLDivElement>(
  options: Options = {},
): [(el: T | null) => void, boolean] {
  const { rootMargin = '200px', once = true } = options;
  const [inView, setInView] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const setRef = useCallback(
    (el: T | null) => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
      if (!el) return;
      if (typeof IntersectionObserver === 'undefined') {
        setInView(true);
        return;
      }
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              setInView(true);
              if (once) {
                observer.disconnect();
                observerRef.current = null;
              }
            } else if (!once) {
              setInView(false);
            }
          }
        },
        { rootMargin },
      );
      observer.observe(el);
      observerRef.current = observer;
    },
    [rootMargin, once],
  );

  return [setRef, inView];
}
