import type { Connection, TrackedBoard } from '../types';
import type { ProjectRecord } from '../projects/projectTypes';

export const PRAXIS_WORKSPACE_FORMAT = 'praxis-workspace';

/**
 * v2 added `projects`, `connections` and `boards` to the file, so a workspace
 * kept outside the app is self-contained: one file holding the workspace, the
 * projects in it, and how those projects reach their backends. v1 files carry
 * only the workspace record and still open — the extra collections are optional
 * and absent means "none".
 *
 * Credentials are never written to the file whatever the version. They are
 * encrypted with the OS keychain and scoped to one machine, so a copy in a repo
 * would be both unreadable elsewhere and a leak.
 */
export const CURRENT_WORKSPACE_SCHEMA_VERSION = 2;

/**
 * Saved workspaces are written as `<slug>.workspace.praxis`. The dialog filter
 * matches on the final segment only (Electron ignores the `.workspace.` part),
 * so `PRAXIS_WORKSPACE_FILE_EXTENSION` is what the open/save filters use.
 */
export const PRAXIS_WORKSPACE_FILE_EXTENSION = 'praxis';
export const PRAXIS_WORKSPACE_FILE_SUFFIX = '.workspace.praxis';

/** `My Team` → `my-team.workspace.praxis` — the default name for a saved workspace file. */
export function workspaceFileName(name: string): string {
  const slug = name.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `${slug || 'workspace'}${PRAXIS_WORKSPACE_FILE_SUFFIX}`;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  description: string;
  projectIds: string[];
  connectionIds: string[];
  objectives: string[];
  defaultProjectId?: string;
  /**
   * Absolute path of the `.workspace.praxis` file this workspace is stored in,
   * when it is kept outside the app. Absent means the app's own user folder
   * holds it. Set from the location registry as the record is loaded, never
   * written into the file itself — a file that has been moved would otherwise
   * carry a stale path.
   */
  storagePath?: string;
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
  /**
   * Folder to keep this workspace in, instead of the app's user folder. The
   * file is created inside it as `<slug>.workspace.praxis` and holds the
   * workspace, its projects and its connections — so the workspace travels with
   * a repo, and deleting the file removes everything it owns.
   */
  storageFolder?: string;
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
  /** Projects belonging to this workspace. Absent in v1 files. */
  projects?: ProjectRecord[];
  /** Connection configuration — hosts, keys, folder roots. Never credentials. */
  connections?: Connection[];
  /** Tracked boards for those connections. */
  boards?: TrackedBoard[];
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

/** What a workspace owns besides its own record — everything that travels with it. */
export interface WorkspaceContents {
  projects?: ProjectRecord[];
  connections?: Connection[];
  boards?: TrackedBoard[];
}

export function toWorkspaceFile(workspace: WorkspaceRecord, contents: WorkspaceContents = {}): WorkspaceFile {
  validateWorkspace(workspace);
  // `storagePath` is where the file lives, which the file itself must not
  // claim: moving or copying it would leave the copy pointing at the original.
  const { storagePath: _ignored, ...record } = workspace;
  return {
    format: PRAXIS_WORKSPACE_FORMAT,
    schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
    createdWithAppVersion: workspace.createdWithAppVersion,
    lastSavedWithAppVersion: workspace.lastSavedWithAppVersion,
    workspace: JSON.parse(JSON.stringify(record)) as WorkspaceRecord,
    ...(contents.projects ? { projects: JSON.parse(JSON.stringify(contents.projects)) as ProjectRecord[] } : {}),
    ...(contents.connections ? { connections: stripSecretsFromConnections(contents.connections) } : {}),
    ...(contents.boards ? { boards: JSON.parse(JSON.stringify(contents.boards)) as TrackedBoard[] } : {})
  };
}

/**
 * Connection settings are written as-is except for anything that looks like a
 * credential. Secrets belong in the OS keychain and are addressed separately;
 * a token that reached `settings` by an older code path must not be the thing
 * that leaks when a workspace file is committed to a repo.
 */
const SECRET_SETTING_PATTERN = /token|secret|password|apikey|api_key|\bpat\b/i;

export function stripSecretsFromConnections(connections: Connection[]): Connection[] {
  return connections.map(connection => ({
    ...JSON.parse(JSON.stringify(connection)) as Connection,
    settings: Object.fromEntries(
      Object.entries(connection.settings ?? {}).filter(([key]) => !SECRET_SETTING_PATTERN.test(key))
    )
  }));
}

export function parseWorkspaceFile(raw: string): WorkspaceRecord {
  return readWorkspaceFile(raw).workspace;
}

/** The whole document — the workspace plus everything stored alongside it. */
export function readWorkspaceFile(raw: string): { workspace: WorkspaceRecord } & WorkspaceContents {
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
  return {
    workspace,
    ...(Array.isArray(parsed.projects) ? { projects: parsed.projects } : {}),
    ...(Array.isArray(parsed.connections) ? { connections: parsed.connections } : {}),
    ...(Array.isArray(parsed.boards) ? { boards: parsed.boards } : {})
  };
}
