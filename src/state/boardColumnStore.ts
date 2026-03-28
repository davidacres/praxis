import * as vscode from 'vscode';
import type { BoardColumnPreferences } from '../types';

const STORAGE_KEY = 'ticketManager.boardColumnPreferences';

type PersistedMap = Record<string, BoardColumnPreferences>;

export class BoardColumnStore implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();

  public readonly onDidChange = this.onDidChangeEmitter.event;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public getPreferences(boardId: string): BoardColumnPreferences {
    const map = this.getAll();
    return map[boardId] ?? { orderedStatuses: [] };
  }

  public async setPreferences(boardId: string, prefs: BoardColumnPreferences): Promise<void> {
    const map = { ...this.getAll() };
    map[boardId] = {
      orderedStatuses: [...prefs.orderedStatuses]
    };
    await this.context.workspaceState.update(STORAGE_KEY, map);
    this.onDidChangeEmitter.fire();
  }

  public async clearPreferences(boardId: string): Promise<void> {
    const map = { ...this.getAll() };
    delete map[boardId];
    await this.context.workspaceState.update(STORAGE_KEY, map);
    this.onDidChangeEmitter.fire();
  }

  private getAll(): PersistedMap {
    return this.context.workspaceState.get<PersistedMap>(STORAGE_KEY) ?? {};
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}
