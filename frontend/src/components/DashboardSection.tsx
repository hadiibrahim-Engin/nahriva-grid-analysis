import type { ReactNode } from 'react';
import { useInView } from '../hooks/useInView';
import { workspaceDefinition, type WorkspaceId } from '../util/workspaces';

/** Keep the anchor mounted while expensive content waits until the section is near the viewport. */
export default function DashboardSection({ workspace, lazy = false, children }: {
  workspace: WorkspaceId;
  lazy?: boolean;
  children: ReactNode;
}) {
  const meta = workspaceDefinition(workspace);
  const [ref, inView] = useInView<HTMLElement>({ rootMargin: '300px' });
  return (
    <section ref={ref} id={`workspace-${workspace}`} data-workspace={workspace} aria-labelledby={`heading-${workspace}`} className="dashboard-section">
      <header className="workspace-heading">
        <div><span className="workspace-heading__eyebrow">Analysis</span><h2 id={`heading-${workspace}`}>{meta.label}</h2></div>
        <p>{meta.description}</p>
      </header>
      <div className="workspace-content">
        {!lazy || inView ? children : <div className="dashboard-section__placeholder" aria-hidden />}
      </div>
    </section>
  );
}
