import { randomUUID } from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk' with { 'resolution-mode': 'import' };
import type { AiProvider, IssueDetails } from '../../types';
import { buildSystemPrompt } from '../agentPrompt';
import { AGENT_DEFAULTS, type AgentEventSummary, type AgentEventType, type AgentTaskDefinition } from '../agentTypes';
import type { AiSessionManager } from '../aiSessionManager';
import type { PermissionDecision } from '../tools';
import { AcpClientWrapper, type AcpPermissionRequest } from './acpClient';

/**
 * Phase-2 peer of `VercelAgentService` for `kind: 'cli-agent'` providers —
 * hosts an ACP-compatible CLI agent (Claude Code, Codex) as a subprocess
 * instead of driving `agentLoop.ts`'s chat-completions loop directly. Reuses
 * the same `AiSessionManager` state machine (session records, events,
 * `awaiting_approval` permission state) so the renderer needs no new UI —
 * an ACP permission request surfaces through the exact same approval flow a
 * local-tools session already uses.
 */

export interface AcpAgentLogger {
  appendLine(message: string): void;
}

export interface AcpAgentStartOptions {
  /** Executable to spawn — e.g. `claude-agent-acp`, `codex-acp`. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  workingDirectory?: string;
}

interface ActiveAcpTask {
  issueKey: string;
  client: AcpClientWrapper;
  pendingPermissions: Array<{
    request: AcpPermissionRequest;
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

export class AcpAgentHost {
  private readonly activeTasks = new Map<string, ActiveAcpTask>();
  private readonly activeTaskListeners = new Set<(issueKey: string) => void>();

  constructor(
    private readonly sessionManager: AiSessionManager,
    private readonly logger: AcpAgentLogger
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
        this.logger.appendLine(`[AcpAgent] Active task listener failed for ${issueKey}: ${message}`);
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

  private requestPermission(issueKey: string, request: AcpPermissionRequest): Promise<PermissionDecision> {
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
      this.appendEvent(issueKey, evt('permission_requested', request.title, request.kind));
    });
  }

  private handleSessionUpdate(issueKey: string, update: acp.SessionUpdate, task: ActiveAcpTask): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = update.content.type === 'text' ? update.content.text : '';
        if (!text) {
          break;
        }
        task.messageBuffer += text;
        this.sessionManager.updateAgentOutput(issueKey, { responseText: task.messageBuffer }, { persist: false });
        if (this.sessionManager.getAgentSession(issueKey)?.state === 'planning') {
          this.sessionManager.setAgentPlan(issueKey, task.messageBuffer, { persist: false });
        }
        break;
      }
      case 'agent_thought_chunk': {
        const text = update.content.type === 'text' ? update.content.text : '';
        if (text) {
          this.sessionManager.updateAgentOutput(issueKey, { reasoningText: text }, { persist: false });
        }
        break;
      }
      case 'tool_call':
        this.appendEvent(issueKey, evt('tool_start', `Running tool: ${update.title || update.name || update.toolCallId}`));
        break;
      case 'tool_call_update':
        if (update.status === 'completed' || update.status === 'failed') {
          this.appendEvent(
            issueKey,
            evt(
              'tool_complete',
              `Tool ${update.status === 'completed' ? 'completed' : 'failed'}: ${update.toolCallId}`
            ),
            1
          );
        }
        break;
      default:
        break;
    }
  }

  public async startTask(
    issue: IssueDetails,
    taskDefinition: AgentTaskDefinition,
    provider: AiProvider,
    options: AcpAgentStartOptions
  ): Promise<string> {
    if (this.activeTasks.has(issue.key)) {
      await this.abortTask(issue.key);
    }

    const workingDirectory = options.workingDirectory?.trim() || process.cwd();
    const sessionId = randomUUID();
    const systemPrompt = buildSystemPrompt(taskDefinition, issue);
    // ACP's `session/prompt` has no separate system-role slot in the
    // high-level `ActiveSession.prompt(text)` API — the CLI agent supplies
    // its own persona, so the task's own instructions travel as one prompt.
    const combinedPrompt = `${systemPrompt}\n\nExecute the task described above.\n\nIssue: ${issue.key} — ${issue.summary}`;

    const client = new AcpClientWrapper({
      command: options.command,
      args: options.args,
      env: options.env,
      workingDirectory,
      requestPermission: request => this.requestPermission(issue.key, request),
      onSessionUpdate: update => {
        const active = this.activeTasks.get(issue.key);
        if (!active || active.ending) {
          return;
        }
        this.handleSessionUpdate(issue.key, update, active);
      },
      logSink: this.logger
    });

    const task: ActiveAcpTask = {
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
    this.appendEvent(issue.key, evt('session_start', 'CLI agent session started'));
    this.logger.appendLine(
      `[AcpAgent] Starting session for ${issue.key} provider=${provider} command=${options.command} cwd=${workingDirectory}`
    );

    const timeoutMs = taskDefinition.timeoutMs ?? AGENT_DEFAULTS.timeoutMs;
    const timeoutHandle = setTimeout(() => {
      void this.stopTask(issue.key, {
        terminalState: 'failed',
        event: evt('error', `Task stopped after timing out at ${Math.round(timeoutMs / 1000)}s.`),
        logLine: `[AcpAgent] Timeout reached for ${issue.key} (${timeoutMs}ms)`
      });
    }, timeoutMs);

    task.promptPromise = (async () => {
      await client.connect();
      const response = await client.prompt(combinedPrompt);
      const active = this.activeTasks.get(issue.key);
      if (!active || active.ending) {
        return;
      }
      this.sessionManager.updateAgentOutput(issue.key, { responseText: active.messageBuffer });
      if (response.stopReason === 'end_turn' || response.stopReason === 'max_turn_requests') {
        this.sessionManager.updateAgentState(issue.key, 'completed');
        this.appendEvent(issue.key, evt('task_complete', 'Agent completed the task'));
      } else if (response.stopReason === 'cancelled') {
        // abortTask already sets the terminal state.
      } else {
        this.sessionManager.updateAgentState(issue.key, 'failed');
        this.appendEvent(issue.key, evt('error', `Agent stopped: ${response.stopReason}`));
      }
    })()
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.appendLine(`[AcpAgent] Session failed for ${issue.key}: ${message}`);
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
      logLine: `[AcpAgent] Aborted task for ${issueKey}`
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
