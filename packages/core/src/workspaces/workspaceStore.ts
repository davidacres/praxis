import type { KeyValueStore } from '../host/stateStore';
import type { CreateWorkspaceInput, UpdateWorkspaceInput, WorkspaceRecord } from './workspaceTypes';
import { CURRENT_WORKSPACE_SCHEMA_VERSION, validateWorkspace } from './workspaceTypes';

const WORKSPACES_KEY = 'praxis.workspaces.v1';

export class WorkspaceStore {
  public constructor(private readonly state: KeyValueStore) {}

  public list(): WorkspaceRecord[] {
    const value = this.state.get<WorkspaceRecord[]>(WORKSPACES_KEY);
    return Array.isArray(value) ? value.filter(isWorkspace).map(clone) : [];
  }

  public get(id: string): WorkspaceRecord | undefined {
    const item = this.list().find(workspace => workspace.id === id);
    return item ? clone(item) : undefined;
  }

  public async create(input: CreateWorkspaceInput, appVersion: string): Promise<WorkspaceRecord> {
    const now = new Date().toISOString();
    const workspace: WorkspaceRecord = {
      id: `workspace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: input.name.trim(), description: input.description?.trim() ?? '',
      projectIds: [...new Set(input.projectIds ?? [])], connectionIds: [...new Set(input.connectionIds ?? [])],
      objectives: (input.objectives ?? []).map(item => item.trim()).filter(Boolean),
      defaultProjectId: input.defaultProjectId, createdAt: now, updatedAt: now,
      createdWithAppVersion: appVersion, lastSavedWithAppVersion: appVersion,
      schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION
    };
    validateWorkspace(workspace);
    const all = this.list();
    all.push(workspace);
    await this.state.update(WORKSPACES_KEY, all);
    return clone(workspace);
  }

  public async update(id: string, patch: UpdateWorkspaceInput, appVersion: string): Promise<WorkspaceRecord> {
    const current = this.get(id);
    if (!current) throw new Error(`Workspace ${id} was not found.`);
    const next: WorkspaceRecord = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
      ...(patch.projectIds !== undefined ? { projectIds: [...new Set(patch.projectIds)] } : {}),
      ...(patch.connectionIds !== undefined ? { connectionIds: [...new Set(patch.connectionIds)] } : {}),
      ...(patch.objectives !== undefined ? { objectives: patch.objectives.map(item => item.trim()).filter(Boolean) } : {}),
      ...(patch.defaultProjectId !== undefined ? { defaultProjectId: patch.defaultProjectId || undefined } : {}),
      updatedAt: new Date().toISOString(), lastSavedWithAppVersion: appVersion
    };
    validateWorkspace(next);
    const all = this.list();
    all[all.findIndex(item => item.id === id)] = next;
    await this.state.update(WORKSPACES_KEY, all);
    return clone(next);
  }

  public async replace(workspace: WorkspaceRecord, appVersion: string): Promise<WorkspaceRecord> {
    return this.update(workspace.id, workspace, appVersion);
  }

  public async import(workspace: WorkspaceRecord, appVersion: string): Promise<WorkspaceRecord> {
    validateWorkspace(workspace);
    const imported = { ...clone(workspace), lastSavedWithAppVersion: appVersion, updatedAt: new Date().toISOString() };
    const all = this.list();
    const index = all.findIndex(item => item.id === imported.id);
    if (index >= 0) all[index] = imported;
    else all.push(imported);
    await this.state.update(WORKSPACES_KEY, all);
    return clone(imported);
  }

  public async remove(id: string): Promise<void> {
    const next = this.list().filter(workspace => workspace.id !== id);
    if (next.length === this.list().length) throw new Error(`Workspace ${id} was not found.`);
    await this.state.update(WORKSPACES_KEY, next);
  }
}

function isWorkspace(value: unknown): value is WorkspaceRecord {
  const workspace = value as Partial<WorkspaceRecord> | undefined;
  return !!workspace && typeof workspace.id === 'string' && typeof workspace.name === 'string' && Array.isArray(workspace.projectIds);
}

function clone(workspace: WorkspaceRecord): WorkspaceRecord { return JSON.parse(JSON.stringify(workspace)) as WorkspaceRecord; }
