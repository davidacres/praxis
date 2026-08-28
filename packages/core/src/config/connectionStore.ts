import type { BackendMode, Connection, TrackedBoard, TrackedBoardRef } from '../types';
import { Emitter, type Disposable } from '../host/emitter';
import type { KeyValueStore } from '../host/stateStore';
import type { SecretsStore } from '../host/secrets';

const CONNECTIONS_KEY = 'connections';
const BOARDS_KEY = 'boards';
const SECRET_PREFIX = 'praxis.connection';

const VALID_MODES: ReadonlySet<BackendMode> = new Set<BackendMode>([
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
  const rawMode = typeof raw.mode === 'string' ? raw.mode.trim() : '';
  const mode = (rawMode === 'jira' ? 'jiracloud' : rawMode) as BackendMode;
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
 * the `connections` / `boards` settings keys; per-connection secrets live in
 * SecretsStore keyed by connection id. Host-agnostic: the VS Code adapter
 * backs `settings` with `vscode.workspace.getConfiguration('praxis')`
 * and forwards `vscode.workspace.onDidChangeConfiguration` into
 * `notifyChanged()`; the Electron adapter backs it with a JSON settings file
 * and has no external change source to forward.
 */
export class ConnectionStore implements Disposable {
  private readonly onDidChangeEmitter = new Emitter<void>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  public constructor(
    private readonly settings: KeyValueStore,
    private readonly secrets: SecretsStore
  ) {}

  /** Hosts call this when the underlying settings changed outside of this store's own writes. */
  public notifyChanged(): void {
    this.onDidChangeEmitter.fire();
  }

  public getConnections(): Connection[] {
    const raw = this.settings.get<unknown[]>(CONNECTIONS_KEY) ?? [];
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
    const raw = this.settings.get<unknown[]>(BOARDS_KEY) ?? [];
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
    // Both writes target the SAME settings document, so they must not run
    // concurrently: each is read-modify-write, and in parallel the second
    // restores the key the first just changed — which let a removed connection
    // reappear. Secrets live in their own store, so that part is safe to run
    // alongside.
    const purgeSecrets = this.purgeSecretsForConnection(connectionId);
    await this.writeConnections(remainingConnections);
    await this.writeTrackedBoards(remainingBoards);
    await purgeSecrets;
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
    return this.secrets.get(secretKey(connectionId, name));
  }

  public async setSecret(connectionId: string, name: string, value: string | undefined): Promise<void> {
    const key = secretKey(connectionId, name);
    if (value === undefined || value.length === 0) {
      await this.secrets.delete(key);
      return;
    }
    await this.secrets.store(key, value);
  }

  /**
   * Records the set of secret names a connection uses so that
   * `purgeSecretsForConnection` can find and delete them. Call this whenever
   * `setSecret` is used for a previously unknown name.
   */
  public async trackSecretName(connectionId: string, name: string): Promise<void> {
    const indexKey = secretKey(connectionId, '__index__');
    const existing = await this.secrets.get(indexKey);
    const names = existing ? new Set(existing.split('\n').filter(Boolean)) : new Set<string>();
    if (!names.has(name)) {
      names.add(name);
      await this.secrets.store(indexKey, [...names].join('\n'));
    }
  }

  private async purgeSecretsForConnection(connectionId: string): Promise<void> {
    const indexKey = secretKey(connectionId, '__index__');
    const existing = await this.secrets.get(indexKey);
    if (existing) {
      const names = existing.split('\n').filter(Boolean);
      await Promise.all(names.map(name => this.secrets.delete(secretKey(connectionId, name))));
    }
    await this.secrets.delete(indexKey);
  }

  private async writeConnections(connections: Connection[]): Promise<void> {
    await this.settings.update(CONNECTIONS_KEY, connections);
    this.onDidChangeEmitter.fire();
  }

  private async writeTrackedBoards(boards: TrackedBoard[]): Promise<void> {
    await this.settings.update(BOARDS_KEY, boards);
    this.onDidChangeEmitter.fire();
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}
