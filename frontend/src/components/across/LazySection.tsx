import { useEffect, useState, type ReactNode } from 'react';
import { useInView } from '../../hooks/useInView';
import { OPEN_SECTION_EVENT } from '../../util/acrossScenarios';

/**
 * Mounts its content only when it comes close to the viewport (or when the navigation asks for it),
 * and then keeps it. Heavy sections therefore cost nothing - no render, no chart code, no request -
 * until they are looked at. The placeholder carries the section id so that navigation still finds it.
 */
export default function LazySection({ id, label, minHeight = 120, children }: {
  id: string;
  label: string;
  minHeight?: number;
  children: ReactNode;
}) {
  const [ref, inView] = useInView<HTMLDivElement>({ rootMargin: '600px' });
  const [forced, setForced] = useState(false);
  useEffect(() => {
    const open = (event: Event) => { if ((event as CustomEvent<string>).detail === id) setForced(true); };
    window.addEventListener(OPEN_SECTION_EVENT, open);
    return () => window.removeEventListener(OPEN_SECTION_EVENT, open);
  }, [id]);
  if (inView || forced) return <>{children}</>;
  return <div ref={ref} id={id} className="across-card ab-lazy" style={{ minHeight }} aria-busy><span>{label}</span></div>;
}
