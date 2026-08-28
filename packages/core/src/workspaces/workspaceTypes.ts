export const PRAXIS_WORKSPACE_FORMAT = 'praxis-workspace';
export const CURRENT_WORKSPACE_SCHEMA_VERSION = 1;

export interface WorkspaceRecord {
  id: string;
  name: string;
  description: string;
  projectIds: string[];
  connectionIds: string[];
  objectives: string[];
  defaultProjectId?: string;
  createdAt: string;
  updatedAt: string;
  createdWithAppVersion: string;
  lastSavedWithAppVersion: string;
  schemaVersion: number;
}

export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  projectIds?: string[];
  connectionIds?: string[];
  objectives?: string[];
  defaultProjectId?: string;
}

export interface UpdateWorkspaceInput {
  name?: string;
  description?: string;
  projectIds?: string[];
  connectionIds?: string[];
  objectives?: string[];
  defaultProjectId?: string;
}

export interface WorkspaceFile {
  format: typeof PRAXIS_WORKSPACE_FORMAT;
  schemaVersion: number;
  createdWithAppVersion: string;
  lastSavedWithAppVersion: string;
  workspace: WorkspaceRecord;
}

export function validateWorkspace(workspace: WorkspaceRecord): void {
  if (!workspace.name.trim()) throw new Error('Workspace name is required.');
  if (workspace.schemaVersion > CURRENT_WORKSPACE_SCHEMA_VERSION) {
    throw new Error(`This workspace was created with a newer Praxis workspace format (v${workspace.schemaVersion}). Update Praxis before opening it.`);
  }
  if (workspace.defaultProjectId && !workspace.projectIds.includes(workspace.defaultProjectId)) {
    throw new Error('The default project must belong to the workspace.');
  }
}

export function toWorkspaceFile(workspace: WorkspaceRecord): WorkspaceFile {
  validateWorkspace(workspace);
  return {
    format: PRAXIS_WORKSPACE_FORMAT,
    schemaVersion: workspace.schemaVersion,
    createdWithAppVersion: workspace.createdWithAppVersion,
    lastSavedWithAppVersion: workspace.lastSavedWithAppVersion,
    workspace: JSON.parse(JSON.stringify(workspace)) as WorkspaceRecord
  };
}

export function parseWorkspaceFile(raw: string): WorkspaceRecord {
  let parsed: Partial<WorkspaceFile>;
  try { parsed = JSON.parse(raw) as Partial<WorkspaceFile>; }
  catch { throw new Error('The selected file is not valid JSON.'); }
  if (parsed.format !== PRAXIS_WORKSPACE_FORMAT || !parsed.workspace) {
    throw new Error('This file is not a Praxis workspace.');
  }
  const workspace = {
    ...parsed.workspace,
    schemaVersion: parsed.schemaVersion ?? parsed.workspace.schemaVersion ?? 1,
    createdWithAppVersion: parsed.createdWithAppVersion ?? parsed.workspace.createdWithAppVersion ?? 'unknown',
    lastSavedWithAppVersion: parsed.lastSavedWithAppVersion ?? parsed.workspace.lastSavedWithAppVersion ?? 'unknown'
  } as WorkspaceRecord;
  validateWorkspace(workspace);
  return workspace;
}
