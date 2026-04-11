import * as vscode from 'vscode';
import type { IssueDetails } from '../types';
import type { AiSessionManager } from './aiSessionManager';
import type {
  AgentEventSummary,
  AgentEventType,
  AgentTaskDefinition
} from './agentTypes';
import { AGENT_DEFAULTS } from './agentTypes';

interface ActiveTask {
  issueKey: string;
  client: { stop(): Promise<unknown> };
  session: {
    sessionId: string;
    send(options: { prompt: string }): Promise<unknown>;
    on(handler: (event: { type: string; data?: Record<string, unknown> }) => void): () => void;
    abort(): Promise<void>;
    disconnect(): Promise<void>;
  };
  unsubscribes: Array<() => void>;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  /** Resolvers for pending permission requests. */
  pendingPermission?: {
    resolve: (result: 'allow_once' | 'allow_always' | 'deny') => void;
  };
  /** Resolvers for pending user-input requests. */
  pendingInput?: {
    resolve: (response: string) => void;
  };
}

const PLANNING_SYSTEM_PROMPT = `You are an autonomous Copilot-powered worker operating under strict contracts.

## Core Contract
- Plan before acting: your FIRST response MUST be a step-by-step plan.
- Operate within the clearly defined scope provided.
- Respect explicit permission boundaries — never bypass permission prompts.
- Stop deterministically when the Definition of Done is satisfied.
- Surface progress and intent continuously.
- You must never improvise your own lifecycle.

## Guardrails
- Stopping correctly is a success condition.
- Do not continuously replan or retry — if a step fails, report the failure.
- Do not modify code outside the stated scope.
- Do not fix pre-existing issues unrelated to the task.
`;

function buildSystemPrompt(task: AgentTaskDefinition, issue: IssueDetails): string {
  const nonGoals = task.nonGoals?.length
    ? `\n## Non-Goals (do NOT touch)\n${task.nonGoals.map(g => `- ${g}`).join('\n')}`
    : '';

  return `${PLANNING_SYSTEM_PROMPT}
## Task
**Goal:** ${task.goal}
**Scope:** ${task.scope}
**Definition of Done:** ${task.definitionOfDone}
${nonGoals}

## Issue Context
- Key: ${issue.key}
- Summary: ${issue.summary}
- Type: ${issue.issueType}
- Status: ${issue.status}
${issue.description ? `- Description:\n${issue.description.slice(0, 4000)}` : ''}
`;
}

function now(): string {
  return new Date().toISOString();
}

function evt(type: AgentEventType, summary: string, detail?: string): AgentEventSummary {
  return { timestamp: now(), type, summary, detail };
}

export class CopilotAgentService implements vscode.Disposable {
  private activeTasks = new Map<string, ActiveTask>();

  constructor(
    private readonly sessionManager: AiSessionManager,
    private readonly output: vscode.OutputChannel
  ) {}

  /** Start a new Copilot agent task for an issue. */
  public async startTask(
    issue: IssueDetails,
    taskDefinition: AgentTaskDefinition,
    options: { cliPath: string; workingDirectory?: string }
  ): Promise<string> {
    // Abort any existing task for this issue
    if (this.activeTasks.has(issue.key)) {
      await this.abortTask(issue.key);
    }

    const sdk = await import('@github/copilot-sdk');
    const cliPath = options.cliPath.trim();
    if (!cliPath) {
      throw new Error('Copilot CLI path is not configured (ticketManager.ai.copilotCliPath).');
    }

    const client = new sdk.CopilotClient({ cliPath });
    await client.start();

    const maxSteps = taskDefinition.maxSteps ?? AGENT_DEFAULTS.maxSteps;
    const timeoutMs = taskDefinition.timeoutMs ?? AGENT_DEFAULTS.timeoutMs;

    const systemPrompt = buildSystemPrompt(taskDefinition, issue);

    // Pre-register task stub so permission/input handlers can find it immediately
    const task: ActiveTask = {
      issueKey: issue.key,
      client,
      session: undefined!, // populated after createSession
      unsubscribes: []
    };
    this.activeTasks.set(issue.key, task);

    let session: ActiveTask['session'];
    try {
      session = await client.createSession({
        clientName: 'ticket-manager-agent',
        infiniteSessions: { enabled: true },
        systemMessage: { content: systemPrompt },
        workingDirectory: options.workingDirectory,
        onPermissionRequest: async (request: { kind: string; [key: string]: unknown }) => {
          const t = this.activeTasks.get(issue.key);
          if (!t) {
            return { kind: 'denied-by-permission-request-hook' as const, message: 'Session not found' };
          }

          const description = request.kind
            ? `Permission requested: ${request.kind}`
            : 'Permission requested';

          this.sessionManager.updateAgentState(issue.key, 'awaiting_approval');
          this.appendEvent(issue.key, evt('permission_requested', description));

          return new Promise((resolve) => {
            t.pendingPermission = {
              resolve: (decision) => {
                t.pendingPermission = undefined;
                this.sessionManager.updateAgentState(issue.key, 'executing');
                this.appendEvent(issue.key, evt('permission_completed', `Permission: ${decision}`));
                if (decision === 'deny') {
                  resolve({ kind: 'denied-by-permission-request-hook' as const, message: 'User denied permission' });
                } else {
                  resolve({ kind: 'approved' as const });
                }
              }
            };
          });
        },
        onUserInputRequest: async (request: { question: string; choices?: string[]; allowFreeform?: boolean }) => {
          const t = this.activeTasks.get(issue.key);
          if (!t) {
            return { answer: 'Session not found', wasFreeform: true };
          }

          const question = request.question ?? 'Input requested';

          this.sessionManager.updateAgentState(issue.key, 'awaiting_input');
          this.appendEvent(issue.key, evt('user_input_requested', question));

          return new Promise<{ answer: string; wasFreeform: boolean }>((resolve) => {
            t.pendingInput = {
              resolve: (response) => {
                t.pendingInput = undefined;
                this.sessionManager.updateAgentState(issue.key, 'executing');
                this.appendEvent(issue.key, evt('user_input_completed', `User replied`));
                resolve({ answer: response, wasFreeform: true });
              }
            };
          });
        }
      });
    } catch (err) {
      // Clean up client if session creation fails
      this.activeTasks.delete(issue.key);
      try { await client.stop(); } catch { /* best-effort */ }
      throw err;
    }

    task.session = session;

    // Create persisted record
    this.sessionManager.createAgentSession(issue.key, session.sessionId, taskDefinition);

    // Subscribe to session events
    const unsubAll = session.on((event) => {
      this.handleSessionEvent(issue.key, event, maxSteps);
    });
    task.unsubscribes.push(unsubAll);

    // Timeout watchdog
    task.timeoutHandle = setTimeout(() => {
      this.output.appendLine(`[Agent] Timeout reached for ${issue.key} (${timeoutMs}ms)`);
      void this.abortTask(issue.key);
    }, timeoutMs);

    // Transition to planning and send initial prompt
    this.sessionManager.updateAgentState(issue.key, 'planning');
    this.appendEvent(issue.key, evt('session_start', 'Copilot agent session started'));

    const initialPrompt = `Execute the task described in the system prompt. Start by producing a step-by-step plan, then execute it.

Issue: ${issue.key} — ${issue.summary}`;

    // Fire and don't await — the event stream will track progress
    session.send({ prompt: initialPrompt }).catch((err: Error) => {
      this.output.appendLine(`[Agent] Send error for ${issue.key}: ${err.message}`);
      this.sessionManager.updateAgentState(issue.key, 'failed');
      this.appendEvent(issue.key, evt('error', `Send failed: ${err.message}`));
    });

    this.output.appendLine(`[Agent] Started task for ${issue.key} (session ${session.sessionId})`);
    return session.sessionId;
  }

  /** Resume a previously disconnected session. */
  public async resumeTask(
    issueKey: string,
    options: { cliPath: string; workingDirectory?: string }
  ): Promise<void> {
    const record = this.sessionManager.getAgentSession(issueKey);
    if (!record) {
      throw new Error(`No agent session found for ${issueKey}`);
    }

    const sdk = await import('@github/copilot-sdk');
    const client = new sdk.CopilotClient({ cliPath: options.cliPath.trim() });
    await client.start();

    const maxSteps = record.taskDefinition.maxSteps ?? AGENT_DEFAULTS.maxSteps;
    const session = await client.resumeSession(record.sessionId, {
      onPermissionRequest: sdk.approveAll
    });

    const task: ActiveTask = {
      issueKey,
      client,
      session,
      unsubscribes: []
    };
    this.activeTasks.set(issueKey, task);

    const unsub = session.on((event) => {
      this.handleSessionEvent(issueKey, event, maxSteps);
    });
    task.unsubscribes.push(unsub);

    this.appendEvent(issueKey, evt('session_start', 'Session resumed'));
    this.output.appendLine(`[Agent] Resumed session for ${issueKey}`);
  }

  /** Respond to a pending user-input request. */
  public respondToInput(issueKey: string, response: string): void {
    const task = this.activeTasks.get(issueKey);
    if (!task?.pendingInput) {
      return;
    }
    task.pendingInput.resolve(response);
  }

  /** Respond to a pending permission request. */
  public respondToPermission(
    issueKey: string,
    decision: 'allow_once' | 'allow_always' | 'deny'
  ): void {
    const task = this.activeTasks.get(issueKey);
    if (!task?.pendingPermission) {
      return;
    }
    task.pendingPermission.resolve(decision);
  }

  /** Abort a running agent task. */
  public async abortTask(issueKey: string): Promise<void> {
    const task = this.activeTasks.get(issueKey);
    if (!task) {
      return;
    }

    try {
      await task.session.abort();
    } catch {
      // Best-effort abort
    }

    this.sessionManager.updateAgentState(issueKey, 'aborted');
    this.appendEvent(issueKey, evt('aborted', 'Task aborted by user'));
    await this.cleanupTask(issueKey);
    this.output.appendLine(`[Agent] Aborted task for ${issueKey}`);
  }

  /** Check if an issue has an active in-memory task. */
  public hasActiveTask(issueKey: string): boolean {
    return this.activeTasks.has(issueKey);
  }

  public dispose(): void {
    for (const issueKey of [...this.activeTasks.keys()]) {
      void this.cleanupTask(issueKey);
    }
  }

  // ── Event Handling ─────────────────────────────────────────────

  private handleSessionEvent(
    issueKey: string,
    event: { type: string; data?: Record<string, unknown> },
    maxSteps: number
  ): void {
    const data = event.data ?? {};

    switch (event.type) {
      case 'assistant.intent':
        this.appendEvent(issueKey, evt('intent', `Intent: ${data.content ?? ''}`));
        break;

      case 'assistant.message': {
        const content = typeof data.content === 'string' ? data.content : '';
        const preview = content.length > 200 ? `${content.slice(0, 200)}…` : content;
        this.appendEvent(issueKey, evt('message', preview, content));

        // Capture first message as plan if still in planning state
        const record = this.sessionManager.getAgentSession(issueKey);
        if (record?.state === 'planning' && content.length > 0) {
          this.sessionManager.setAgentPlan(issueKey, content);
          this.sessionManager.updateAgentState(issueKey, 'executing');
        }
        break;
      }

      case 'session.plan_changed': {
        const plan = typeof data.plan === 'string' ? data.plan : JSON.stringify(data);
        this.sessionManager.setAgentPlan(issueKey, plan);
        this.appendEvent(issueKey, evt('plan', 'Plan updated'));
        break;
      }

      case 'tool.execution_start': {
        const name = typeof data.name === 'string' ? data.name : 'unknown';
        this.appendEvent(issueKey, evt('tool_start', `Running tool: ${name}`));
        break;
      }

      case 'tool.execution_complete': {
        const name = typeof data.name === 'string' ? data.name : 'unknown';
        this.appendEvent(issueKey, evt('tool_complete', `Tool completed: ${name}`), 1);

        // Guardrail: max step count
        const rec = this.sessionManager.getAgentSession(issueKey);
        if (rec && rec.stepCount >= maxSteps) {
          this.output.appendLine(`[Agent] Max steps (${maxSteps}) reached for ${issueKey}`);
          void this.abortTask(issueKey);
        }
        break;
      }

      case 'session.idle': {
        const record = this.sessionManager.getAgentSession(issueKey);
        if (record && record.state === 'executing') {
          this.sessionManager.updateAgentState(issueKey, 'completed');
          this.appendEvent(issueKey, evt('idle', 'Session idle — task complete'));
          void this.cleanupTask(issueKey);
        }
        break;
      }

      case 'session.task_complete': {
        const summary = typeof data.summary === 'string' ? data.summary : 'Task complete';
        this.sessionManager.updateAgentState(issueKey, 'completed');
        this.appendEvent(issueKey, evt('task_complete', summary));
        void this.cleanupTask(issueKey);
        break;
      }

      case 'session.error': {
        const message = typeof data.message === 'string' ? data.message : 'Unknown error';
        this.sessionManager.updateAgentState(issueKey, 'failed');
        this.appendEvent(issueKey, evt('error', `Error: ${message}`));
        void this.cleanupTask(issueKey);
        break;
      }

      case 'session.info': {
        const msg = typeof data.message === 'string' ? data.message : '';
        if (msg) {
          this.appendEvent(issueKey, evt('info', msg));
        }
        break;
      }

      case 'session.warning': {
        const msg = typeof data.message === 'string' ? data.message : '';
        if (msg) {
          this.appendEvent(issueKey, evt('warning', `Warning: ${msg}`));
        }
        break;
      }
    }
  }

  private appendEvent(
    issueKey: string,
    event: AgentEventSummary,
    incrementSteps?: number
  ): void {
    this.sessionManager.appendAgentEvents(issueKey, [event], incrementSteps);
    this.output.appendLine(`[Agent:${issueKey}] ${event.type}: ${event.summary}`);
  }

  private async cleanupTask(issueKey: string): Promise<void> {
    const task = this.activeTasks.get(issueKey);
    if (!task) {
      return;
    }

    // Remove from map immediately to prevent concurrent cleanup
    this.activeTasks.delete(issueKey);

    if (task.timeoutHandle) {
      clearTimeout(task.timeoutHandle);
    }
    for (const unsub of task.unsubscribes) {
      unsub();
    }

    // Resolve any pending permission/input promises so SDK handlers don't hang
    if (task.pendingPermission) {
      task.pendingPermission.resolve('deny');
    }
    if (task.pendingInput) {
      task.pendingInput.resolve('Task ended');
    }

    try {
      await task.session.disconnect();
    } catch {
      // Best-effort cleanup
    }
    try {
      await task.client.stop();
    } catch {
      // Best-effort cleanup
    }
  }
}
