import * as vscode from 'vscode';
import type { BoardColumnPreferences } from '@ticket-manager/core';

const STORAGE_KEY = 'ticketManager.boardColumnPreferences';

type PersistedMap = Record<string, BoardColumnPreferences>;

function normalizeStatuses(statuses: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const status of statuses) {
    const trimmed = status.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function buildLegacyWorkflowOrder(defaultWorkflow: string[]): string[] {
  const normalized = normalizeStatuses(defaultWorkflow);
  return normalized.includes('Backlog')
    ? ['Backlog', ...normalized.filter(status => status !== 'Backlog')]
    : normalized;
}

function realignLegacyStatuses(savedStatuses: string[], defaultWorkflow: string[]): string[] | undefined {
  const normalizedSaved = normalizeStatuses(savedStatuses);
  const normalizedWorkflow = normalizeStatuses(defaultWorkflow);
  if (
    normalizedSaved.length === 0 ||
    normalizedWorkflow.length === 0 ||
    normalizedSaved[0] !== 'Backlog' ||
    normalizedWorkflow[0] === 'Backlog' ||
    !normalizedWorkflow.includes('Backlog')
  ) {
    return undefined;
  }

  const workflowSet = new Set(normalizedWorkflow);
  if (normalizedSaved.some(status => !workflowSet.has(status))) {
    return undefined;
  }

  return normalizedWorkflow.filter(status => normalizedSaved.includes(status));
}

function hasPreferenceData(prefs: BoardColumnPreferences): boolean {
  return Boolean(
    prefs.workflowStatuses.length > 0 ||
      prefs.orderedStatuses.length > 0 ||
      prefs.projectPillColor ||
      (prefs.swimLaneGroupBy && prefs.swimLaneGroupBy !== 'none') ||
      prefs.issueFilterAssignee ||
      prefs.issueFilterEpicKey ||
      (prefs.issueFilterStatuses && prefs.issueFilterStatuses.length > 0) ||
      (prefs.statusColors && Object.keys(prefs.statusColors).length > 0) ||
      (prefs.issueTypeColors && Object.keys(prefs.issueTypeColors).length > 0) ||
      prefs.viewMode === 'list' ||
      (prefs.listGroupOrder && prefs.listGroupOrder.length > 0) ||
      prefs.maxAgeWeeks !== undefined ||
      (prefs.issueOrder && Object.keys(prefs.issueOrder).length > 0)
  );
}

export function repairLegacyBacklogStatusPreferences(
  prefs: BoardColumnPreferences,
  defaultWorkflow: string[]
): BoardColumnPreferences {
  const normalizedWorkflow = normalizeStatuses(defaultWorkflow);
  const repairedWorkflow = realignLegacyStatuses(prefs.workflowStatuses, normalizedWorkflow);
  let nextWorkflowStatuses = prefs.workflowStatuses;
  if (repairedWorkflow) {
    nextWorkflowStatuses = arraysEqual(repairedWorkflow, normalizedWorkflow)
      ? []
      : repairedWorkflow;
  }
  const effectiveWorkflow = nextWorkflowStatuses.length > 0 ? nextWorkflowStatuses : normalizedWorkflow;
  const repairedOrdered = realignLegacyStatuses(prefs.orderedStatuses, effectiveWorkflow);
  let nextOrderedStatuses = prefs.orderedStatuses;
  if (repairedOrdered) {
    nextOrderedStatuses = arraysEqual(repairedOrdered, effectiveWorkflow)
      ? []
      : repairedOrdered;
  }

  if (
    arraysEqual(nextWorkflowStatuses, prefs.workflowStatuses) &&
    arraysEqual(nextOrderedStatuses, prefs.orderedStatuses)
  ) {
    return prefs;
  }

  return {
    ...prefs,
    workflowStatuses: nextWorkflowStatuses,
    orderedStatuses: nextOrderedStatuses
  };
}

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
    if (prefs.issueTypeColors && Object.keys(prefs.issueTypeColors).length > 0) {
      next.issueTypeColors = { ...prefs.issueTypeColors };
    }
    if (prefs.viewMode === 'list') {
      next.viewMode = prefs.viewMode;
    }
    if (prefs.listGroupOrder?.length) {
      next.listGroupOrder = [...prefs.listGroupOrder];
    }
    if (prefs.maxAgeWeeks !== undefined) {
      next.maxAgeWeeks = prefs.maxAgeWeeks;
    }
    if (prefs.issueOrder && Object.keys(prefs.issueOrder).length > 0) {
      next.issueOrder = { ...prefs.issueOrder };
    }
    map[boardId] = next;
    await this.context.workspaceState.update(STORAGE_KEY, map);
    this.onDidChangeEmitter.fire();
  }

  public async setIssueOrder(
    boardId: string,
    status: string,
    orderedKeys: string[]
  ): Promise<void> {
    const prefs = this.getPreferences(boardId);
    const issueOrder = prefs.issueOrder ? { ...prefs.issueOrder } : {};
    issueOrder[status] = orderedKeys;
    await this.setPreferences(boardId, { ...prefs, issueOrder });
  }

  public async setViewMode(boardId: string, viewMode: 'board' | 'list'): Promise<void> {
    const prefs = this.getPreferences(boardId);
    await this.setPreferences(boardId, { ...prefs, viewMode });
  }

  public async setGroupOrder(boardId: string, orderedStatuses: string[]): Promise<void> {
    const prefs = this.getPreferences(boardId);
    await this.setPreferences(boardId, { ...prefs, listGroupOrder: orderedStatuses });
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

  public async normalizeLegacyPreferences(
    boardId: string,
    defaultWorkflow: string[]
  ): Promise<BoardColumnPreferences> {
    const current = this.getPreferences(boardId);
    const repaired = repairLegacyBacklogStatusPreferences(current, defaultWorkflow);
    if (repaired === current) {
      return current;
    }

    if (hasPreferenceData(repaired)) {
      await this.setPreferences(boardId, repaired);
    } else {
      await this.clearPreferences(boardId);
    }
    return repaired;
  }

  private getAll(): PersistedMap {
    return this.context.workspaceState.get<PersistedMap>(STORAGE_KEY) ?? {};
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}
