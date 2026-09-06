import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CURRENT_WORKSPACE_SCHEMA_VERSION,
  PRAXIS_WORKSPACE_FORMAT,
  readWorkspaceFile,
  stripSecretsFromConnections,
  type Connection,
  type KeyValueStore,
  type ProjectRecord,
  type TrackedBoard,
  type WorkspaceFile,
  type WorkspaceRecord
} from '@praxis/core';

/** Store keys this file answers for. Anything else is not a workspace's business. */
const WORKSPACES_KEY = 'praxis.workspaces.v1';
const PROJECTS_KEY = 'praxis.projects.v1';
const CONNECTIONS_KEY = 'connections';
const BOARDS_KEY = 'boards';

export const WORKSPACE_FILE_KEYS: ReadonlySet<string> = new Set([
  WORKSPACES_KEY,
  PROJECTS_KEY,
  CONNECTIONS_KEY,
  BOARDS_KEY
]);

/**
 * A single `.workspace.praxis` file presented as a `KeyValueStore`.
 *
 * The file is the live store for a workspace kept outside the app, not a
 * snapshot of one: the workspace record, the projects in it, its connections
 * and their tracked boards all live in this one document, so the workspace can
 * sit in a repo and travel with it, and deleting the file removes everything it
 * owned in one action.
 *
 * Credentials are never written here — `ConnectionStore` keeps those in the OS
 * keychain, addressed by connection id, and they stay in the user folder.
 *
 * Only the four keys above are stored. An update for any other key is dropped
 * rather than written, so app-wide settings cannot leak into a file the user
 * may be about to commit.
 */
export class WorkspaceFileStore implements KeyValueStore {
  private document: WorkspaceFile;
  /** Serialises writes, exactly as `JsonKeyValueStore` does — same race. */
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(public readonly filePath: string) {
    this.document = this.load();
  }

  /** The workspace this file holds, with its location stamped on. */
  public get workspaceId(): string {
    return this.document.workspace.id;
  }

  public get<T>(key: string): T | undefined {
    switch (key) {
      case WORKSPACES_KEY:
        // Stamped on read, never stored: a file that has been moved or copied
        // must report where it actually is, not where it once was.
        return [{ ...this.document.workspace, storagePath: this.filePath }] as unknown as T;
      case PROJECTS_KEY:
        return (this.document.projects ?? []) as unknown as T;
      case CONNECTIONS_KEY:
        return (this.document.connections ?? []) as unknown as T;
      case BOARDS_KEY:
        return (this.document.boards ?? []) as unknown as T;
      default:
        return undefined;
    }
  }

  public async update(key: string, value: unknown): Promise<void> {
    const next = { ...this.document };
    switch (key) {
      case WORKSPACES_KEY: {
        const records = Array.isArray(value) ? (value as WorkspaceRecord[]) : [];
        const record = records.find(item => item.id === this.document.workspace.id) ?? records[0];
        // An empty slice means the workspace was removed from the app. The file
        // is the user's — deregistering is the app's job, deleting is theirs.
        if (!record) return;
        const { storagePath: _location, ...stored } = record;
        next.workspace = stored as WorkspaceRecord;
        next.lastSavedWithAppVersion = record.lastSavedWithAppVersion;
        break;
      }
      case PROJECTS_KEY:
        next.projects = Array.isArray(value) ? (value as ProjectRecord[]) : [];
        break;
      case CONNECTIONS_KEY:
        next.connections = Array.isArray(value) ? stripSecretsFromConnections(value as Connection[]) : [];
        break;
      case BOARDS_KEY:
        next.boards = Array.isArray(value) ? (value as TrackedBoard[]) : [];
        break;
      default:
        return;
    }

    const previous = this.document;
    this.document = next;
    const write = this.writeQueue.then(() => this.persist());
    this.writeQueue = write.then(() => undefined, () => undefined);
    try {
      await write;
    } catch (error) {
      this.document = previous;
      throw error;
    }
  }

  private load(): WorkspaceFile {
    const raw = fs.readFileSync(this.filePath, 'utf8');
    // Relative folder paths resolve against the file's own directory.
    const parsed = readWorkspaceFile(raw, path.dirname(path.resolve(this.filePath)));
    return {
      format: PRAXIS_WORKSPACE_FORMAT,
      schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
      createdWithAppVersion: parsed.workspace.createdWithAppVersion,
      lastSavedWithAppVersion: parsed.workspace.lastSavedWithAppVersion,
      workspace: parsed.workspace,
      projects: parsed.projects ?? [],
      connections: stripSecretsFromConnections(parsed.connections ?? []),
      boards: parsed.boards ?? []
    };
  }

  private async persist(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(tempPath, `${JSON.stringify(this.document, null, 2)}\n`, 'utf8');
    try {
      await fs.promises.rename(tempPath, this.filePath);
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/** Writes a brand-new, empty workspace file. Fails if one is already there. */
export async function createWorkspaceFile(filePath: string, workspace: WorkspaceRecord): Promise<void> {
  const { storagePath: _location, ...stored } = workspace;
  const document: WorkspaceFile = {
    format: PRAXIS_WORKSPACE_FORMAT,
    schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
    createdWithAppVersion: workspace.createdWithAppVersion,
    lastSavedWithAppVersion: workspace.lastSavedWithAppVersion,
    workspace: stored as WorkspaceRecord,
    projects: [],
    connections: [],
    boards: []
  };
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.promises.open(filePath, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}
