import { useEffect, useRef } from 'react';
import {
  Activity,
  BarChart3,
  Boxes,
  GitBranch,
  LayoutDashboard,
  Network,
  Scale,
  type LucideIcon,
} from 'lucide-react';
import { WORKSPACES, type WorkspaceId } from '../util/workspaces';

const WORKSPACE_ICONS: Record<WorkspaceId, LucideIcon> = {
  assessment: LayoutDashboard,
  scenarios: Activity,
  network: Network,
  assets: Boxes,
  n1: GitBranch,
  compare: Scale,
  charts: BarChart3,
};

export default function WorkspaceRail({ value, onChange }: {
  value: WorkspaceId;
  onChange: (workspace: WorkspaceId) => void;
}) {
  const rail = useRef<HTMLElement>(null);
  useEffect(() => {
    const container = rail.current;
    const current = container?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!container || !current || container.scrollWidth <= container.clientWidth) return;
    const bounds = container.getBoundingClientRect();
    const item = current.getBoundingClientRect();
    if (item.left < bounds.left) container.scrollLeft -= bounds.left - item.left + 8;
    else if (item.right > bounds.right) container.scrollLeft += item.right - bounds.right + 8;
  }, [value]);
  return (
    <aside ref={rail} className="workspace-rail">
      <div className="workspace-rail__eyebrow">Analysis</div>
      <nav className="workspace-rail__nav" aria-label="Analysis sections">
        {WORKSPACES.map(({ id, label, shortLabel, description }) => {
          const Icon = WORKSPACE_ICONS[id];
          return <button
            key={id}
            type="button"
            className="workspace-rail__item"
            aria-current={value === id ? 'location' : undefined}
            title={`${label} — ${description}`}
            onClick={() => onChange(id)}
          >
            <Icon size={17} strokeWidth={1.8} aria-hidden />
            <span className="workspace-rail__label">{label}</span>
            <span className="workspace-rail__short">{shortLabel}</span>
          </button>;
        })}
      </nav>
      <div className="workspace-rail__hint">
        Scroll to explore. Select a section to jump to it; n-1 results load on request.
      </div>
    </aside>
  );
}
