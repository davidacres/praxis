import { randomUUID } from 'node:crypto';
import type { AiProvider, IssueDetails } from '../../types';
import { buildSystemPrompt } from '../agentPrompt';
import { AGENT_DEFAULTS, type AgentEventSummary, type AgentEventType, type AgentTaskDefinition } from '../agentTypes';
import type { AiSessionManager } from '../aiSessionManager';
import type { PermissionDecision } from '../tools';
import { CopilotClientWrapper, type CopilotPermissionRequest, type CopilotToolEvent } from './copilotClient';

/**
 * `kind: 'cli-agent'`, `hostKind: 'copilot-sdk'` peer of `AcpAgentHost` —
 * hosts a GitHub Copilot session via `@github/copilot-sdk` instead of an
 * ACP subprocess. Reuses the same `AiSessionManager` state machine (session
 * records, events, `awaiting_approval` permission state) so the renderer
 * needs no new UI: a Copilot permission request surfaces through the exact
 * same approval card an ACP or local-tools session uses.
 */

export interface CopilotAgentLogger {
  appendLine(message: string): void;
}

export interface CopilotAgentStartOptions {
  /** Overrides the bundled `@github/copilot` runtime executable; omit to use the SDK default. */
  runtimePath?: string;
  model?: string;
  workingDirectory?: string;
}

interface ActiveCopilotTask {
  issueKey: string;
  client: CopilotClientWrapper;
  pendingPermissions: Array<{
    request: CopilotPermissionRequest;
    resolve: (decision: PermissionDecision) => void;
  }>;
  allowPermissionsForTask: boolean;
  messageBuffer: string;
  promptPromise?: Promise<void>;
  ending?: boolean;
}

function now(): string {
  return new Date().toISOString();
}

function evt(type: AgentEventType, summary: string, detail?: string): AgentEventSummary {
  return { timestamp: now(), type, summary, detail };
}

export class CopilotAgentHost {
  private readonly activeTasks = new Map<string, ActiveCopilotTask>();
  private readonly activeTaskListeners = new Set<(issueKey: string) => void>();

  constructor(
    private readonly sessionManager: AiSessionManager,
    private readonly logger: CopilotAgentLogger
  ) {}

  public onDidChangeActiveTask(listener: (issueKey: string) => void): () => void {
    this.activeTaskListeners.add(listener);
    return () => {
      this.activeTaskListeners.delete(listener);
    };
  }

  private emitActiveTaskChange(issueKey: string): void {
    for (const listener of this.activeTaskListeners) {
      try {
        listener(issueKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.appendLine(`[CopilotAgent] Active task listener failed for ${issueKey}: ${message}`);
      }
    }
  }

  private isTerminalState(state: string | undefined): boolean {
    return state === 'completed' || state === 'failed' || state === 'aborted';
  }

  private appendEvent(issueKey: string, event: AgentEventSummary, incrementSteps?: number): void {
    this.sessionManager.appendAgentEvents(issueKey, [event], incrementSteps);
  }

  public hasActiveTask(issueKey: string): boolean {
    return this.activeTasks.has(issueKey);
  }

  public getActiveTaskIssueKeys(): string[] {
    return [...this.activeTasks.keys()];
  }

  private requestPermission(issueKey: string, request: CopilotPermissionRequest): Promise<PermissionDecision> {
    const task = this.activeTasks.get(issueKey);
    if (!task) {
      return Promise.resolve('deny');
    }
    if (task.allowPermissionsForTask) {
      return Promise.resolve('allow_always');
    }
    return new Promise<PermissionDecision>(resolve => {
      task.pendingPermissions.push({ request, resolve });
      this.sessionManager.updateAgentState(issueKey, 'awaiting_approval');
      this.appendEvent(issueKey, evt('permission_requested', request.title, request.detail));
    });
  }

  private handleToolEvent(issueKey: string, toolEvent: CopilotToolEvent): void {
    if (toolEvent.phase === 'start') {
      this.appendEvent(issueKey, evt('tool_start', `Running tool: ${toolEvent.toolName}`));
    } else {
      this.appendEvent(
        issueKey,
        evt('tool_complete', `Tool ${toolEvent.success === false ? 'failed' : 'completed'}: ${toolEvent.toolName}`),
        1
      );
    }
  }

  public async startTask(
    issue: IssueDetails,
    taskDefinition: AgentTaskDefinition,
    provider: AiProvider,
    options: CopilotAgentStartOptions
  ): Promise<string> {
    if (this.activeTasks.has(issue.key)) {
      await this.abortTask(issue.key);
    }

    const workingDirectory = options.workingDirectory?.trim() || process.cwd();
    const sessionId = randomUUID();
    const systemPrompt = buildSystemPrompt(taskDefinition, issue);
    // The Copilot SDK's `session.send`/`sendAndWait` has no separate
    // system-role slot (like ACP's `ActiveSession.prompt(text)`) — the
    // runtime supplies its own persona, so the task's instructions travel
    // as one combined prompt.
    const combinedPrompt = `${systemPrompt}\n\nExecute the task described above.\n\nIssue: ${issue.key} — ${issue.summary}`;

    const client = new CopilotClientWrapper({
      workingDirectory,
      runtimePath: options.runtimePath,
      model: options.model,
      requestPermission: request => this.requestPermission(issue.key, request),
      onMessageDelta: text => {
        const active = this.activeTasks.get(issue.key);
        if (!active || active.ending) {
          return;
        }
        active.messageBuffer += text;
        this.sessionManager.updateAgentOutput(issue.key, { responseText: active.messageBuffer }, { persist: false });
      },
      onToolEvent: toolEvent => {
        const active = this.activeTasks.get(issue.key);
        if (!active || active.ending) {
          return;
        }
        this.handleToolEvent(issue.key, toolEvent);
      },
      logSink: this.logger
    });

    const task: ActiveCopilotTask = {
      issueKey: issue.key,
      client,
      pendingPermissions: [],
      allowPermissionsForTask: false,
      messageBuffer: ''
    };
    this.activeTasks.set(issue.key, task);
    this.emitActiveTaskChange(issue.key);

    this.sessionManager.createAgentSession(issue.key, sessionId, taskDefinition, provider);
    this.sessionManager.updateAgentState(issue.key, 'planning');
    this.appendEvent(issue.key, evt('session_start', 'Copilot session started'));
    this.logger.appendLine(`[CopilotAgent] Starting session for ${issue.key} provider=${provider} cwd=${workingDirectory}`);

    const timeoutMs = taskDefinition.timeoutMs ?? AGENT_DEFAULTS.timeoutMs;
    const timeoutHandle = setTimeout(() => {
      void this.stopTask(issue.key, {
        terminalState: 'failed',
        event: evt('error', `Task stopped after timing out at ${Math.round(timeoutMs / 1000)}s.`),
        logLine: `[CopilotAgent] Timeout reached for ${issue.key} (${timeoutMs}ms)`
      });
    }, timeoutMs);

    task.promptPromise = (async () => {
      await client.connect();
      const response = await client.prompt(combinedPrompt);
      const active = this.activeTasks.get(issue.key);
      if (!active || active.ending) {
        return;
      }
      this.sessionManager.updateAgentOutput(issue.key, { responseText: active.messageBuffer || response.content });
      if (response.errored) {
        this.sessionManager.updateAgentState(issue.key, 'failed');
        this.appendEvent(issue.key, evt('error', 'Copilot session errored before completing.'));
      } else {
        this.sessionManager.updateAgentState(issue.key, 'completed');
        this.appendEvent(issue.key, evt('task_complete', 'Agent completed the task'));
      }
    })()
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.appendLine(`[CopilotAgent] Session failed for ${issue.key}: ${message}`);
        const record = this.sessionManager.getAgentSession(issue.key);
        if (record && !this.isTerminalState(record.state)) {
          this.sessionManager.updateAgentState(issue.key, 'failed');
          this.appendEvent(issue.key, evt('error', message));
        }
      })
      .finally(() => {
        clearTimeout(timeoutHandle);
        void this.cleanupTask(issue.key);
      });

    return sessionId;
  }

  public respondToPermission(issueKey: string, decision: PermissionDecision): void {
    const task = this.activeTasks.get(issueKey);
    if (!task || task.pendingPermissions.length === 0) {
      return;
    }

    if (decision === 'allow_always') {
      task.allowPermissionsForTask = true;
      const pending = task.pendingPermissions.splice(0);
      for (const request of pending) {
        request.resolve(decision);
      }
      this.appendEvent(
        issueKey,
        evt(
          'permission_completed',
          `Permission: ${decision} (${pending.length} queued request${pending.length === 1 ? '' : 's'})`
        )
      );
      this.sessionManager.updateAgentState(issueKey, 'executing');
      return;
    }

    const pending = task.pendingPermissions.shift();
    if (!pending) {
      return;
    }
    pending.resolve(decision);
    this.appendEvent(issueKey, evt('permission_completed', `Permission: ${decision}`));

    if (task.pendingPermissions.length > 0) {
      this.sessionManager.updateAgentState(issueKey, 'awaiting_approval');
    } else {
      this.sessionManager.updateAgentState(issueKey, 'executing');
    }
  }

  public async abortTask(issueKey: string): Promise<void> {
    await this.stopTask(issueKey, {
      terminalState: 'aborted',
      event: evt('aborted', 'Task aborted by user'),
      logLine: `[CopilotAgent] Aborted task for ${issueKey}`
    });
  }

  public dispose(): void {
    for (const issueKey of [...this.activeTasks.keys()]) {
      void this.abortTask(issueKey);
    }
  }

  private async stopTask(
    issueKey: string,
    options: { terminalState: 'aborted' | 'failed'; event: AgentEventSummary; logLine: string }
  ): Promise<void> {
    const task = this.activeTasks.get(issueKey);
    if (!task) {
      return;
    }
    if (task.ending) {
      await task.promptPromise;
      return;
    }
    task.ending = true;
    for (const pending of task.pendingPermissions.splice(0)) {
      pending.resolve('deny');
    }
    await task.client.cancel().catch(() => {});

    const record = this.sessionManager.getAgentSession(issueKey);
    if (record && !this.isTerminalState(record.state)) {
      this.sessionManager.updateAgentState(issueKey, options.terminalState);
      this.appendEvent(issueKey, options.event);
    }
    this.logger.appendLine(options.logLine);
    await this.cleanupTask(issueKey);
  }

  private async cleanupTask(issueKey: string): Promise<void> {
    const task = this.activeTasks.get(issueKey);
    if (!task) {
      return;
    }
    task.client.dispose();
    this.activeTasks.delete(issueKey);
    this.emitActiveTaskChange(issueKey);
  }
}
