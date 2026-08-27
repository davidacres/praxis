import { randomUUID } from 'node:crypto';
import type { AiProvider, IssueDetails } from '../../types';
import { buildSystemPrompt } from '../agentPrompt';
import {
  AGENT_DEFAULTS,
  type AgentEventSummary,
  type AgentEventType,
  type AgentSessionRecord,
  type AgentTaskDefinition,
  type AgentToolMode
} from '../agentTypes';
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
  toolMode?: AgentToolMode;
  runtimeSessionId?: string;
}

export interface CopilotPromptOptions extends CopilotAgentStartOptions {
  signal?: AbortSignal;
  onUpdate?: (content: string) => void;
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
    const record = this.sessionManager.getAgentSession(issueKey);
    if (
      (record?.toolMode === 'project-only' || (record?.toolMode === 'read-only' &&
      ['write', 'shell', 'mcp', 'custom-tool', 'extension-management', 'factory'].includes(request.kind)))
    ) {
      this.appendEvent(issueKey, evt('warning', `Blocked by read-only tools: ${request.title}`));
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
    const toolMode = options.toolMode ?? (taskDefinition.kind === 'analysis' ? 'read-only' : 'full');
    const sessionId = randomUUID();
    const systemPrompt = `${buildSystemPrompt(taskDefinition, issue)}\n\nTool mode: ${
      toolMode === 'read-only'
        ? 'READ ONLY. Do not edit files, execute commands, or mutate external systems.'
        : 'FULL. Use tools as needed; honor every permission request.'
    }`;
    // The Copilot SDK's `session.send`/`sendAndWait` has no separate
    // system-role slot (like ACP's `ActiveSession.prompt(text)`) — the
    // runtime supplies its own persona, so the task's instructions travel
    // as one combined prompt.
    const combinedPrompt = taskDefinition.sessionMode === 'chat'
      ? `${systemPrompt}\n\nRespond directly to the user's request. Do not start a ticket analysis or inspect a ticket unless explicitly asked.`
      : `${systemPrompt}\n\nExecute the task described above.\n\nIssue: ${issue.key} — ${issue.summary}`;

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

    this.sessionManager.createAgentSession(issue.key, sessionId, taskDefinition, provider, options.model, {
      workingDirectory,
      toolMode
    });
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
      if (client.sessionId) this.sessionManager.updateAgentRuntime(issue.key, { runtimeSessionId: client.sessionId });
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

  /** Runs a read-only, one-turn prompt without creating or replacing a tracked task session. */
  public async promptOnce(prompt: string, options: CopilotPromptOptions): Promise<string> {
    let content = '';
    const client = new CopilotClientWrapper({
      workingDirectory: options.workingDirectory?.trim() || process.cwd(),
      runtimePath: options.runtimePath,
      model: options.model,
      requestPermission: async () => 'deny',
      onMessageDelta: text => {
        content += text;
        options.onUpdate?.(content);
      },
      logSink: this.logger
    });
    const cancel = () => void client.cancel();
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      await client.connect();
      const response = await client.prompt(prompt);
      const answer = content.trim() || response.content.trim();
      if (!answer) {
        throw new Error('GitHub Copilot returned an empty response.');
      }
      return answer;
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      client.dispose();
    }
  }

  /** Continues a completed tracked session using a fresh Copilot transport plus saved task/response context. */
  private buildConversationTranscript(events: AgentSessionRecord['events']): string | undefined {
    const turns = events.flatMap(event => {
      if (event.type === 'message' && event.detail?.trim()) return [`Assistant:\n${event.detail.trim()}`];
      if (event.type === 'user_input_completed' && event.detail?.trim()) return [`User:\n${event.detail.trim()}`];
      return [];
    });
    return turns.length > 0 ? `Previous conversation:\n\n${turns.join('\n\n')}` : undefined;
  }

  public async continueTask(
    issueKey: string,
    message: string,
    options: CopilotAgentStartOptions
  ): Promise<void> {
    if (this.activeTasks.has(issueKey)) {
      throw new Error(`The agent is still working on ${issueKey}.`);
    }
    const record = this.sessionManager.getAgentSession(issueKey);
    if (!record) throw new Error(`No agent session found for ${issueKey}.`);
    const followUp = message.trim();
    if (!followUp) throw new Error('Enter a follow-up message.');
    const workingDirectory = record.workingDirectory?.trim() || options.workingDirectory?.trim() || process.cwd();
    const toolMode = record.toolMode ?? options.toolMode ?? 'full';
    const systemPrompt = `${buildSystemPrompt(record.taskDefinition, {
      key: issueKey,
      summary: record.taskDefinition.goal,
      issueType: 'Task',
      status: 'In progress',
      description: record.taskDefinition.scope
    } as IssueDetails)}\n\nTool mode: ${
      toolMode === 'read-only'
        ? 'READ ONLY. Do not edit files, execute commands, or mutate external systems.'
        : 'FULL. Use tools as needed; honor every permission request.'
    }`;
    const prompt = [
      systemPrompt,
      this.buildConversationTranscript(record.events),
      `User follow-up:\n${followUp}`
    ].filter((part): part is string => Boolean(part)).join('\n\n');

    const client = new CopilotClientWrapper({
      workingDirectory,
      runtimePath: options.runtimePath,
      model: options.model,
      resumeSessionId: record.runtimeSessionId,
      requestPermission: request => this.requestPermission(issueKey, request),
      onMessageDelta: text => {
        const active = this.activeTasks.get(issueKey);
        if (!active || active.ending) return;
        active.messageBuffer += text;
        this.sessionManager.updateAgentOutput(issueKey, { responseText: active.messageBuffer }, { persist: false });
      },
      onToolEvent: event => this.handleToolEvent(issueKey, event),
      logSink: this.logger
    });
    const task: ActiveCopilotTask = {
      issueKey,
      client,
      pendingPermissions: [],
      allowPermissionsForTask: false,
      messageBuffer: ''
    };
    this.activeTasks.set(issueKey, task);
    this.emitActiveTaskChange(issueKey);
    if (record.responseText) this.appendEvent(issueKey, evt('message', 'Assistant', record.responseText));
    this.appendEvent(issueKey, evt('user_input_completed', 'You', followUp));
    this.sessionManager.updateAgentOutput(issueKey, { responseText: '' });
    this.sessionManager.updateAgentState(issueKey, 'executing');

    task.promptPromise = (async () => {
      await client.connect();
      const response = await client.prompt(prompt);
      if (client.sessionId) this.sessionManager.updateAgentRuntime(issueKey, { runtimeSessionId: client.sessionId });
      const active = this.activeTasks.get(issueKey);
      if (!active || active.ending) return;
      const answer = active.messageBuffer || response.content;
      this.sessionManager.updateAgentOutput(issueKey, { responseText: answer });
      if (answer) this.appendEvent(issueKey, evt('message', 'Assistant', answer));
      if (response.errored) {
        this.sessionManager.updateAgentState(issueKey, 'failed');
        this.appendEvent(issueKey, evt('error', 'Copilot follow-up failed.'));
      } else {
        this.sessionManager.updateAgentState(issueKey, 'completed');
        this.appendEvent(issueKey, evt('task_complete', 'Agent completed the follow-up'));
      }
    })().catch(error => {
      const text = error instanceof Error ? error.message : String(error);
      this.sessionManager.updateAgentState(issueKey, 'failed');
      this.appendEvent(issueKey, evt('error', text));
    }).finally(() => void this.cleanupTask(issueKey));
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
