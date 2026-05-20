import * as vscode from 'vscode';
import type { BackendMode, Connection, TrackedBoard, TrackedBoardRef } from '../types';

const CONFIG_ROOT = 'ticketManager';
const CONNECTIONS_KEY = 'connections';
const BOARDS_KEY = 'boards';
const SECRET_PREFIX = 'ticketManager.connection';

const VALID_MODES: ReadonlySet<BackendMode> = new Set<BackendMode>([
  'jira',
  'jiracloud',
  'demo',
  'github',
  'gitlab',
  'livefolder',
  'userworkspace'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeConnection(raw: unknown): Connection | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const mode = raw.mode as BackendMode;
  if (!id || !name || !VALID_MODES.has(mode)) {
    return undefined;
  }
  return {
    id,
    name,
    mode,
    settings: isRecord(raw.settings) ? { ...raw.settings } : {}
  };
}

function sanitizeTrackedBoard(raw: unknown): TrackedBoard | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const connectionId = typeof raw.connectionId === 'string' ? raw.connectionId.trim() : '';
  const boardId = typeof raw.boardId === 'string' ? raw.boardId.trim() : '';
  if (!connectionId || !boardId) {
    return undefined;
  }
  const board: TrackedBoard = { connectionId, boardId };
  if (typeof raw.displayName === 'string' && raw.displayName.trim().length > 0) {
    board.displayName = raw.displayName.trim();
  }
  return board;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'connection';
}

function secretKey(connectionId: string, name: string): string {
  return `${SECRET_PREFIX}.${connectionId}.${name}`;
}

/**
 * Reads and writes the multi-connection configuration that replaces the
 * single global `backendMode` model. Connections and tracked boards live in
 * `ticketManager.connections` / `ticketManager.boards` settings; per-connection
 * secrets live in VS Code SecretStorage keyed by connection id.
 */
export class ConnectionStore implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.onDidChangeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(private readonly context: vscode.ExtensionContext) {
    const watcher = vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration(`${CONFIG_ROOT}.${CONNECTIONS_KEY}`) ||
        event.affectsConfiguration(`${CONFIG_ROOT}.${BOARDS_KEY}`)
      ) {
        this.onDidChangeEmitter.fire();
      }
    });
    this.disposables.push(watcher);
  }

  public getConnections(): Connection[] {
    const raw = vscode.workspace.getConfiguration(CONFIG_ROOT).get<unknown[]>(CONNECTIONS_KEY, []);
    if (!Array.isArray(raw)) {
      return [];
    }
    const result: Connection[] = [];
    const seenIds = new Set<string>();
    for (const entry of raw) {
      const connection = sanitizeConnection(entry);
      if (!connection || seenIds.has(connection.id)) {
        continue;
      }
      seenIds.add(connection.id);
      result.push(connection);
    }
    return result;
  }

  public getConnection(id: string): Connection | undefined {
    return this.getConnections().find(c => c.id === id);
  }

  public hasConnections(): boolean {
    return this.getConnections().length > 0;
  }

  public getTrackedBoards(): TrackedBoard[] {
    const raw = vscode.workspace.getConfiguration(CONFIG_ROOT).get<unknown[]>(BOARDS_KEY, []);
    if (!Array.isArray(raw)) {
      return [];
    }
    const result: TrackedBoard[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
      const board = sanitizeTrackedBoard(entry);
      if (!board) {
        continue;
      }
      const key = `${board.connectionId}|${board.boardId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(board);
    }
    return result;
  }

  public getTrackedBoardsForConnection(connectionId: string): TrackedBoard[] {
    return this.getTrackedBoards().filter(b => b.connectionId === connectionId);
  }

  public findTrackedBoard(ref: TrackedBoardRef): TrackedBoard | undefined {
    return this.getTrackedBoards().find(
      b => b.connectionId === ref.connectionId && b.boardId === ref.boardId
    );
  }

  /**
   * Returns a stable slug-based id derived from `name` that does not collide
   * with any existing connection id. Used when creating a new connection.
   */
  public generateConnectionId(name: string): string {
    const base = slugify(name);
    const existing = new Set(this.getConnections().map(c => c.id));
    if (!existing.has(base)) {
      return base;
    }
    let suffix = 2;
    while (existing.has(`${base}-${suffix}`)) {
      suffix += 1;
    }
    return `${base}-${suffix}`;
  }

  public async addConnection(connection: Connection): Promise<void> {
    const existing = this.getConnections();
    if (existing.some(c => c.id === connection.id)) {
      throw new Error(`A connection with id "${connection.id}" already exists.`);
    }
    await this.writeConnections([...existing, connection]);
  }

  public async updateConnection(connection: Connection): Promise<void> {
    const existing = this.getConnections();
    const index = existing.findIndex(c => c.id === connection.id);
    if (index === -1) {
      throw new Error(`No connection with id "${connection.id}" exists.`);
    }
    const next = [...existing];
    next[index] = connection;
    await this.writeConnections(next);
  }

  /**
   * Removes the connection, all of its tracked boards, and all of its secrets.
   */
  public async removeConnection(connectionId: string): Promise<void> {
    const remainingConnections = this.getConnections().filter(c => c.id !== connectionId);
    const remainingBoards = this.getTrackedBoards().filter(b => b.connectionId !== connectionId);
    await Promise.all([
      this.writeConnections(remainingConnections),
      this.writeTrackedBoards(remainingBoards),
      this.purgeSecretsForConnection(connectionId)
    ]);
  }

  public async addTrackedBoard(board: TrackedBoard): Promise<void> {
    const existing = this.getTrackedBoards();
    if (existing.some(b => b.connectionId === board.connectionId && b.boardId === board.boardId)) {
      return;
    }
    await this.writeTrackedBoards([...existing, board]);
  }

  public async addTrackedBoards(boards: TrackedBoard[]): Promise<void> {
    if (boards.length === 0) {
      return;
    }
    const existing = this.getTrackedBoards();
    const seen = new Set(existing.map(b => `${b.connectionId}|${b.boardId}`));
    const merged = [...existing];
    for (const board of boards) {
      const key = `${board.connectionId}|${board.boardId}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(board);
      }
    }
    await this.writeTrackedBoards(merged);
  }

  public async updateTrackedBoard(board: TrackedBoard): Promise<void> {
    const existing = this.getTrackedBoards();
    const index = existing.findIndex(
      b => b.connectionId === board.connectionId && b.boardId === board.boardId
    );
    if (index === -1) {
      throw new Error(
        `Tracked board ${board.connectionId}/${board.boardId} not found.`
      );
    }
    const next = [...existing];
    next[index] = board;
    await this.writeTrackedBoards(next);
  }

  public async removeTrackedBoard(ref: TrackedBoardRef): Promise<void> {
    const remaining = this.getTrackedBoards().filter(
      b => !(b.connectionId === ref.connectionId && b.boardId === ref.boardId)
    );
    await this.writeTrackedBoards(remaining);
  }

  public async getSecret(connectionId: string, name: string): Promise<string | undefined> {
    return this.context.secrets.get(secretKey(connectionId, name));
  }

  public async setSecret(connectionId: string, name: string, value: string | undefined): Promise<void> {
    const key = secretKey(connectionId, name);
    if (value === undefined || value.length === 0) {
      await this.context.secrets.delete(key);
      return;
    }
    await this.context.secrets.store(key, value);
  }

  /**
   * Records the set of secret names a connection uses so that
   * `purgeSecretsForConnection` can find and delete them. Call this whenever
   * `setSecret` is used for a previously unknown name.
   */
  public async trackSecretName(connectionId: string, name: string): Promise<void> {
    const indexKey = secretKey(connectionId, '__index__');
    const existing = await this.context.secrets.get(indexKey);
    const names = existing ? new Set(existing.split('\n').filter(Boolean)) : new Set<string>();
    if (!names.has(name)) {
      names.add(name);
      await this.context.secrets.store(indexKey, [...names].join('\n'));
    }
  }

  private async purgeSecretsForConnection(connectionId: string): Promise<void> {
    const indexKey = secretKey(connectionId, '__index__');
    const existing = await this.context.secrets.get(indexKey);
    if (existing) {
      const names = existing.split('\n').filter(Boolean);
      await Promise.all(names.map(name => this.context.secrets.delete(secretKey(connectionId, name))));
    }
    await this.context.secrets.delete(indexKey);
  }

  private async writeConnections(connections: Connection[]): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .update(CONNECTIONS_KEY, connections, target);
  }

  private async writeTrackedBoards(boards: TrackedBoard[]): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .update(BOARDS_KEY, boards, target);
  }

  private configTarget(): vscode.ConfigurationTarget {
    return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

