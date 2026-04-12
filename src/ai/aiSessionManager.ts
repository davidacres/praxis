import * as vscode from 'vscode';
import type { AiAssignment, AiProvider } from '../types';
import type {
  AgentEventSummary,
  AgentSessionRecord,
  AgentTaskDefinition,
  AgentTaskState
} from './agentTypes';

const STORAGE_KEY = 'ticketManager.aiSessions';
const AGENT_STORAGE_KEY = 'ticketManager.agentSessions';

export class AiSessionManager {
  private sessions: Map<string, AiAssignment>;
  private agentSessions: Map<string, AgentSessionRecord>;

  private readonly _onDidChangeSession = new vscode.EventEmitter<{
    issueKey: string;
    session?: AiAssignment;
  }>();
  /** Fires when any AI assignment session changes. */
  public readonly onDidChangeSession = this._onDidChangeSession.event;
  private readonly _onDidChangeAgentSession = new vscode.EventEmitter<AgentSessionRecord>();
  /** Fires when any agent session's state or events change. */
  public readonly onDidChangeAgentSession = this._onDidChangeAgentSession.event;

  public constructor(private readonly workspaceState: vscode.Memento) {
    this.sessions = this.loadSessions();
    this.agentSessions = this.loadAgentSessions();
  }

  /** Create a new AI session for the given issue and provider. */
  public createSession(issueKey: string, provider: AiProvider, label?: string): AiAssignment {
    const assignment: AiAssignment = {
      provider,
      label: label?.trim() || undefined,
      sessionId: this.generateSessionId(),
      assignedAt: new Date().toISOString(),
      status: 'active'
    };
    this.sessions.set(issueKey, assignment);
    void this.persistSessions();
    this._onDidChangeSession.fire({ issueKey, session: assignment });
    return assignment;
  }

  /** Get the active session for an issue, if one exists. */
  public getSession(issueKey: string): AiAssignment | undefined {
    return this.sessions.get(issueKey);
  }

  /** Update the status of an existing session. */
  public updateSessionStatus(
    issueKey: string,
    status: 'active' | 'completed' | 'failed'
  ): void {
    const session = this.sessions.get(issueKey);
    if (!session) {
      return;
    }
    session.status = status;
    void this.persistSessions();
    this._onDidChangeSession.fire({ issueKey, session });
  }

  /** Remove the session for an issue. */
  public removeSession(issueKey: string): void {
    if (this.sessions.delete(issueKey)) {
      void this.persistSessions();
      this._onDidChangeSession.fire({ issueKey, session: undefined });
    }
  }

  /** Return all active sessions as a read-only map. */
  public getActiveSessions(): Map<string, AiAssignment> {
    const active = new Map<string, AiAssignment>();
    for (const [key, assignment] of this.sessions) {
      if (assignment.status === 'active') {
        active.set(key, assignment);
      }
    }
    return active;
  }

  /** Return all sessions (any status). */
  public getAllSessions(): Map<string, AiAssignment> {
    return new Map(this.sessions);
  }

  // ── Agent Session Management ───────────────────────────────────

  /** Create a new Copilot agent session record for an issue. */
  public createAgentSession(
    issueKey: string,
    sessionId: string,
    taskDefinition: AgentTaskDefinition
  ): AgentSessionRecord {
    const record: AgentSessionRecord = {
      issueKey,
      sessionId,
      state: 'not_started',
      taskDefinition,
      events: [],
      stepCount: 0,
      startedAt: new Date().toISOString()
    };
    this.agentSessions.set(issueKey, record);
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
    return record;
  }

  /** Get the agent session for an issue, if one exists. */
  public getAgentSession(issueKey: string): AgentSessionRecord | undefined {
    return this.agentSessions.get(issueKey);
  }

  /** Get all agent sessions. */
  public getAllAgentSessions(): Map<string, AgentSessionRecord> {
    return new Map(this.agentSessions);
  }

  /** Update agent session state and optionally set completedAt. */
  public updateAgentState(issueKey: string, state: AgentTaskState): void {
    const record = this.agentSessions.get(issueKey);
    if (!record) {
      return;
    }
    record.state = state;
    if (state === 'completed') {
      this.updateSessionStatus(issueKey, 'completed');
    } else if (state === 'failed' || state === 'aborted') {
      this.updateSessionStatus(issueKey, 'failed');
    } else {
      this.updateSessionStatus(issueKey, 'active');
    }
    if (state === 'completed' || state === 'failed' || state === 'aborted') {
      record.completedAt = new Date().toISOString();
    }
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
  }

  /** Append events to an agent session and optionally bump step count. */
  public appendAgentEvents(
    issueKey: string,
    events: AgentEventSummary[],
    incrementSteps?: number
  ): void {
    const record = this.agentSessions.get(issueKey);
    if (!record) {
      return;
    }
    record.events.push(...events);
    if (incrementSteps) {
      record.stepCount += incrementSteps;
    }
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
  }

  /** Set the plan text for an agent session. */
  public setAgentPlan(issueKey: string, planText: string): void {
    const record = this.agentSessions.get(issueKey);
    if (!record) {
      return;
    }
    record.planText = planText;
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
  }

  /** Remove agent session for an issue. */
  public removeAgentSession(issueKey: string): void {
    const record = this.agentSessions.get(issueKey);
    if (record) {
      this.agentSessions.delete(issueKey);
      void this.persistAgentSessions();
    }
  }

  public dispose(): void {
    this._onDidChangeSession.dispose();
    this._onDidChangeAgentSession.dispose();
  }

  // ── Internals ──────────────────────────────────────────────────

  private generateSessionId(): string {
    const hex = () => Math.random().toString(16).slice(2, 10);
    return `${hex()}${hex()}`;
  }

  private loadSessions(): Map<string, AiAssignment> {
    const stored = this.workspaceState.get<Record<string, AiAssignment>>(STORAGE_KEY);
    if (!stored || typeof stored !== 'object') {
      return new Map();
    }

    const result = new Map<string, AiAssignment>();
    for (const [key, value] of Object.entries(stored)) {
      if (
        value &&
        typeof value.provider === 'string' &&
        typeof value.sessionId === 'string' &&
        typeof value.assignedAt === 'string' &&
        typeof value.status === 'string'
      ) {
        result.set(key, value);
      }
    }
    return result;
  }

  private async persistSessions(): Promise<void> {
    const record: Record<string, AiAssignment> = {};
    for (const [key, assignment] of this.sessions) {
      record[key] = assignment;
    }
    await this.workspaceState.update(STORAGE_KEY, record);
  }

  private loadAgentSessions(): Map<string, AgentSessionRecord> {
    const stored = this.workspaceState.get<Record<string, AgentSessionRecord>>(AGENT_STORAGE_KEY);
    if (!stored || typeof stored !== 'object') {
      return new Map();
    }
    const result = new Map<string, AgentSessionRecord>();
    for (const [key, value] of Object.entries(stored)) {
      if (
        value &&
        typeof value.sessionId === 'string' &&
        typeof value.state === 'string' &&
        typeof value.taskDefinition === 'object'
      ) {
        result.set(key, value);
      }
    }
    return result;
  }

  private async persistAgentSessions(): Promise<void> {
    const record: Record<string, AgentSessionRecord> = {};
    for (const [key, session] of this.agentSessions) {
      record[key] = session;
    }
    await this.workspaceState.update(AGENT_STORAGE_KEY, record);
  }
}
