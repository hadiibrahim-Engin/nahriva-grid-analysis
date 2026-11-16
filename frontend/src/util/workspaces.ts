export type WorkspaceId = 'assessment' | 'scenarios' | 'network' | 'assets' | 'compare' | 'charts';

export interface WorkspaceDefinition {
  id: WorkspaceId;
  label: string;
  shortLabel: string;
  description: string;
}

export const WORKSPACES: readonly WorkspaceDefinition[] = [
  { id: 'assessment', label: 'Assessment', shortLabel: 'Assess', description: 'Verdict and key indicators' },
  { id: 'scenarios', label: 'Scenarios', shortLabel: 'Scenarios', description: 'Inspect one outage scenario' },
  { id: 'network', label: 'Network', shortLabel: 'Network', description: 'Grid state, voltage and areas' },
  { id: 'assets', label: 'Assets', shortLabel: 'Assets', description: 'Inspect equipment history' },
  { id: 'compare', label: 'Compare', shortLabel: 'Compare', description: 'Compare scenarios and evidence' },
  { id: 'charts', label: 'Charts', shortLabel: 'Charts', description: 'Build time-series and n-1 views' },
] as const;

export function isWorkspaceId(value: string | null): value is WorkspaceId {
  return WORKSPACES.some((workspace) => workspace.id === value);
}

export function workspaceDefinition(id: WorkspaceId): WorkspaceDefinition {
  return WORKSPACES.find((workspace) => workspace.id === id) ?? WORKSPACES[0];
}
