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
  return (
    <aside className="workspace-rail">
      <div className="workspace-rail__eyebrow">Analysis</div>
      <nav className="workspace-rail__nav" aria-label="Analysis workspaces">
        {WORKSPACES.map(({ id, label, shortLabel, description }) => {
          const Icon = WORKSPACE_ICONS[id];
          return <button
            key={id}
            type="button"
            className="workspace-rail__item"
            aria-current={value === id ? 'page' : undefined}
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
        One workspace at a time. Detailed tables open only when requested.
      </div>
    </aside>
  );
}
