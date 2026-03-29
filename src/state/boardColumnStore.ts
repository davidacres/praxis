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
    return map[boardId] ?? { workflowStatuses: [], orderedStatuses: [] };
  }

  public async setPreferences(boardId: string, prefs: BoardColumnPreferences): Promise<void> {
    const map = { ...this.getAll() };
    const next: BoardColumnPreferences = {
      workflowStatuses: [...prefs.workflowStatuses],
      orderedStatuses: [...prefs.orderedStatuses]
    };
    const pill = prefs.projectPillColor?.trim();
    if (pill) {
      next.projectPillColor = pill;
    }
    if (prefs.swimLaneGroupBy && prefs.swimLaneGroupBy !== 'none') {
      next.swimLaneGroupBy = prefs.swimLaneGroupBy;
    }
    const fa = prefs.issueFilterAssignee?.trim();
    if (fa) {
      next.issueFilterAssignee = fa;
    }
    const fe = prefs.issueFilterEpicKey?.trim();
    if (fe) {
      next.issueFilterEpicKey = fe;
    }
    if (prefs.issueFilterStatuses?.length) {
      next.issueFilterStatuses = [...prefs.issueFilterStatuses];
    }
    if (prefs.statusColors && Object.keys(prefs.statusColors).length > 0) {
      next.statusColors = { ...prefs.statusColors };
    }
    map[boardId] = next;
    await this.context.workspaceState.update(STORAGE_KEY, map);
    this.onDidChangeEmitter.fire();
  }

  public async clearPreferences(boardId: string): Promise<void> {
    const map = { ...this.getAll() };
    delete map[boardId];
    await this.context.workspaceState.update(STORAGE_KEY, map);
    this.onDidChangeEmitter.fire();
  }

  public async clearAllPreferences(): Promise<void> {
    await this.context.workspaceState.update(STORAGE_KEY, {});
    this.onDidChangeEmitter.fire();
  }

  private getAll(): PersistedMap {
    return this.context.workspaceState.get<PersistedMap>(STORAGE_KEY) ?? {};
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}
