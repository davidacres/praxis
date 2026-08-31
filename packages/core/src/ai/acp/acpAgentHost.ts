import { randomUUID } from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk' with { 'resolution-mode': 'import' };
import type { AiProvider, IssueDetails } from '../../types';
import { BROWSER_TOOLS_PROMPT, buildSystemPrompt } from '../agentPrompt';
import {
  AGENT_DEFAULTS,
  type AgentEventSummary,
  type AgentEventType,
  type AgentSessionRecord,
  type AgentTaskDefinition,
  type AgentToolEventData,
  type AgentToolFileChange,
  type AgentToolMode
} from '../agentTypes';
import { mapAcpToolKind } from '../toolEventClassify';
import { createUnifiedDiff } from '../tools/unifiedDiff';
import type { AiSessionManager } from '../aiSessionManager';
import type { ModelOptions } from '../providers/modelCatalog';
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
  /** Model id to select via `session/set_config_option` before prompting; omit to use the agent's own default. */
  model?: string;
  toolMode?: AgentToolMode;
  runtimeSessionId?: string;
  /**
   * HTTP MCP servers to expose to the agent for this session (e.g. the in-app
   * browser). Applied only when the agent advertises `mcpCapabilities.http`.
   */
  mcpServers?: AcpHttpMcpServer[];
}

export interface AcpHttpMcpServer {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export interface AcpPromptOptions extends AcpAgentStartOptions {
  signal?: AbortSignal;
  onUpdate?: (content: string) => void;
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

function evt(
  type: AgentEventType,
  summary: string,
  detail?: string,
  data?: AgentToolEventData
): AgentEventSummary {
  return { timestamp: now(), type, summary, detail, ...(data ? { data } : {}) };
}

/** Pulls diff blocks and text output out of an ACP tool-call content array. */
function readAcpToolContent(content: acp.ToolCallContent[] | null | undefined): {
  fileChanges: AgentToolFileChange[];
  output: string;
} {
  const fileChanges: AgentToolFileChange[] = [];
  const textParts: string[] = [];
  for (const block of content ?? []) {
    if (block.type === 'diff') {
      const oldText = block.oldText ?? '';
      fileChanges.push({
        path: block.path,
        oldText,
        newText: block.newText,
        diff: createUnifiedDiff(block.path, oldText, block.newText)
      });
    } else if (block.type === 'content' && block.content?.type === 'text') {
      textParts.push(block.content.text);
    }
  }
  return { fileChanges, output: textParts.join('\n').trim() };
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

  /**
   * The agent's available models and current default, if it exposes a
   * `model`-category `session/new` config option — e.g. Claude Code's
   * Sonnet/Opus/Haiku/Fable or Codex's GPT-5.6 family. Spawns a throwaway
   * connection+session purely to read this protocol data (no prompt is
   * ever sent, so this costs nothing) and disposes it immediately.
   * Returns `undefined` for agents that don't expose model selection.
   */
  public async listAvailableModels(options: AcpAgentStartOptions): Promise<ModelOptions | undefined> {
    const client = new AcpClientWrapper({
      command: options.command,
      args: options.args,
      env: options.env,
      workingDirectory: options.workingDirectory?.trim() || process.cwd(),
      requestPermission: () => Promise.resolve('deny'),
      onSessionUpdate: () => {},
      logSink: this.logger
    });
    try {
      await client.connect();
      const modelOption = await client.getModelOption();
      if (!modelOption || modelOption.type !== 'select') {
        return undefined;
      }
      // `options` is either a flat list, or grouped (e.g. models grouped by
      // provider) — flatten either shape into one list for the picker.
      const flatChoices = modelOption.options.flatMap(entry => ('group' in entry ? entry.options : [entry]));
      return {
        currentValue: modelOption.currentValue,
        options: flatChoices.map(choice => ({
          value: choice.value,
          name: choice.name,
          description: choice.description ?? undefined
        }))
      };
    } finally {
      client.dispose();
    }
  }

  /** Runs a read-only, one-turn prompt without creating or replacing a tracked task session. */
  public async promptOnce(prompt: string, options: AcpPromptOptions): Promise<string> {
    let content = '';
    const client = new AcpClientWrapper({
      command: options.command,
      args: options.args,
      env: options.env,
      workingDirectory: options.workingDirectory?.trim() || process.cwd(),
      requestPermission: async () => 'deny',
      onSessionUpdate: update => {
        if (update.sessionUpdate !== 'agent_message_chunk' || update.content.type !== 'text') {
          return;
        }
        content += update.content.text;
        options.onUpdate?.(content);
      },
      logSink: this.logger
    });
    const cancel = () => void client.cancel();
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      await client.connect();
      if (options.model) {
        await client.setConfigOption('model', options.model);
      }
      await client.prompt(prompt);
      if (!content.trim()) {
        throw new Error('The CLI agent returned an empty response.');
      }
      return content.trim();
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      client.dispose();
    }
  }

  private requestPermission(issueKey: string, request: AcpPermissionRequest): Promise<PermissionDecision> {
    const task = this.activeTasks.get(issueKey);
    if (!task) {
      return Promise.resolve('deny');
    }
    const record = this.sessionManager.getAgentSession(issueKey);
    const permissionText = `${request.kind ?? ''} ${request.title}`.toLowerCase();
    if (
      (record?.toolMode === 'read-only' || record?.toolMode === 'project-only') &&
      (record?.toolMode === 'project-only' || /(write|edit|delete|remove|shell|terminal|command|execute|create|update|transition|comment)/.test(permissionText))
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
      this.appendEvent(issueKey, evt('permission_requested', request.title, request.kind));
    });
  }

  /**
   * Raise a permission prompt that did not originate from the agent's own
   * `session/request_permission` call — used by the in-app browser MCP server,
   * whose tool calls the agent makes directly. Reuses the same pending-approval
   * queue, so `respondToPermission` resolves it and the session's permission
   * card renders it unchanged.
   */
  public promptExternalPermission(issueKey: string, title: string, kind: string): Promise<PermissionDecision> {
    return this.requestPermission(issueKey, {
      toolCallId: `external-${Date.now()}`,
      title,
      kind,
      options: []
    });
  }

  /**
   * Record a tool call the agent made through an out-of-band MCP server (the
   * in-app browser), so it appears in the transcript and step count like the
   * agent's native tool calls. No-op once the task has ended.
   */
  public appendExternalToolEvent(issueKey: string, toolName: string, ok: boolean, content: string): void {
    if (!this.activeTasks.has(issueKey)) return;
    this.appendEvent(
      issueKey,
      evt('tool_complete', `${ok ? 'Tool' : 'Tool failed'}: ${toolName}`, content, { toolName }),
      1
    );
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
      case 'tool_call': {
        const toolName = update.title || update.name || update.toolCallId;
        this.appendEvent(
          issueKey,
          evt('tool_start', `Running tool: ${toolName}`, undefined, {
            callId: update.toolCallId,
            toolName,
            kind: mapAcpToolKind(update.kind ?? undefined),
            argsSummary: update.title ?? undefined
          })
        );
        break;
      }
      case 'tool_call_update':
        if (update.status === 'completed' || update.status === 'failed') {
          const ok = update.status === 'completed';
          const { fileChanges, output } = readAcpToolContent(update.content);
          const rawOutput =
            output ||
            (typeof update.rawOutput === 'string'
              ? update.rawOutput
              : update.rawOutput
                ? JSON.stringify(update.rawOutput, null, 2)
                : '');
          const detail =
            fileChanges.map(change => change.diff ?? '').join('\n').trim() || rawOutput || undefined;
          this.appendEvent(
            issueKey,
            evt(
              'tool_complete',
              `Tool ${ok ? 'completed' : 'failed'}: ${update.title || update.name || update.toolCallId}`,
              detail?.slice(0, 2000),
              {
                callId: update.toolCallId,
                toolName: update.title ?? update.name ?? undefined,
                // `kind` is often only on the initial `tool_call`; diff blocks in
                // the result imply a write even when this update omits it.
                kind: fileChanges.length > 0 ? 'write' : mapAcpToolKind(update.kind ?? undefined),
                ok,
                ...(fileChanges.length > 0 ? { fileChanges, diff: fileChanges[0]?.diff } : {}),
                ...(rawOutput ? { output: rawOutput } : {})
              }
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
    const toolMode = options.toolMode ?? (taskDefinition.kind === 'analysis' ? 'read-only' : 'full');
    const sessionId = randomUUID();
    const hasBrowser = options.mcpServers?.some(server => server.name === 'praxis-browser') ?? false;
    const systemPrompt = `${buildSystemPrompt(taskDefinition, issue)}\n\nTool mode: ${
      toolMode === 'read-only'
        ? 'READ ONLY. Do not edit files, execute commands, or mutate external systems.'
        : 'FULL. Use tools as needed; honor every permission request.'
    }${hasBrowser ? `\n\n${BROWSER_TOOLS_PROMPT}` : ''}`;
    // ACP's `session/prompt` has no separate system-role slot in the
    // high-level `ActiveSession.prompt(text)` API — the CLI agent supplies
    // its own persona, so the task's own instructions travel as one prompt.
    const combinedPrompt = taskDefinition.sessionMode === 'chat'
      ? `${systemPrompt}\n\nRespond directly to the user's request. Do not start a ticket analysis or inspect a ticket unless explicitly asked.`
      : `${systemPrompt}\n\nExecute the task described above.\n\nIssue: ${issue.key} — ${issue.summary}`;

    const client = new AcpClientWrapper({
      command: options.command,
      args: options.args,
      env: options.env,
      workingDirectory,
      toolMode,
      mcpServers: options.mcpServers,
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

    this.sessionManager.createAgentSession(issue.key, sessionId, taskDefinition, provider, options.model, {
      workingDirectory,
      toolMode
    });
    this.sessionManager.updateAgentState(issue.key, 'planning');
    this.appendEvent(issue.key, evt('session_start', 'CLI agent session started'));
    this.logger.appendLine(
      `[AcpAgent] Starting session for ${issue.key} provider=${provider} command=${options.command} cwd=${workingDirectory}${options.model ? ` model=${options.model}` : ''}`
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
      if (options.model) {
        await client.setConfigOption('model', options.model);
      }
      const response = await client.prompt(combinedPrompt);
      if (client.sessionId) {
        this.sessionManager.updateAgentRuntime(issue.key, { runtimeSessionId: client.sessionId });
      }
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

  private buildConversationTranscript(events: AgentSessionRecord['events']): string | undefined {
    const turns = events.flatMap(event => {
      if (event.type === 'message' && event.detail?.trim()) {
        return [`Assistant:\n${event.detail.trim()}`];
      }
      if (event.type === 'user_input_completed' && event.detail?.trim()) {
        return [`User:\n${event.detail.trim()}`];
      }
      return [];
    });
    return turns.length > 0 ? `Previous conversation:\n\n${turns.join('\n\n')}` : undefined;
  }

  /** Continues through native ACP resume when available, with full transcript fallback. */
  public async continueTask(
    issueKey: string,
    message: string,
    options: AcpAgentStartOptions
  ): Promise<void> {
    if (this.activeTasks.has(issueKey)) {
      throw new Error(`The agent is still working on ${issueKey}.`);
    }
    const record = this.sessionManager.getAgentSession(issueKey);
    if (!record) {
      throw new Error(`No agent session found for ${issueKey}.`);
    }
    const followUp = message.trim();
    if (!followUp) {
      throw new Error('Enter a follow-up message.');
    }
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
    }${
      (options.mcpServers?.some(server => server.name === 'praxis-browser') ?? false)
        ? `\n\n${BROWSER_TOOLS_PROMPT}`
        : ''
    }`;
    const prompt = [
      systemPrompt,
      this.buildConversationTranscript(record.events),
      `User follow-up:\n${followUp}`
    ].filter((part): part is string => Boolean(part)).join('\n\n');

    const client = new AcpClientWrapper({
      command: options.command,
      args: options.args,
      env: options.env,
      workingDirectory,
      toolMode,
      mcpServers: options.mcpServers,
      resumeSessionId: record.runtimeSessionId,
      requestPermission: request => this.requestPermission(issueKey, request),
      onSessionUpdate: update => {
        const active = this.activeTasks.get(issueKey);
        if (active && !active.ending) this.handleSessionUpdate(issueKey, update, active);
      },
      logSink: this.logger
    });
    const task: ActiveAcpTask = {
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
      if (options.model) await client.setConfigOption('model', options.model);
      const response = await client.prompt(prompt);
      if (client.sessionId) {
        this.sessionManager.updateAgentRuntime(issueKey, { runtimeSessionId: client.sessionId });
      }
      const active = this.activeTasks.get(issueKey);
      if (!active || active.ending) return;
      this.sessionManager.updateAgentOutput(issueKey, { responseText: active.messageBuffer });
      if (active.messageBuffer) this.appendEvent(issueKey, evt('message', 'Assistant', active.messageBuffer));
      if (response.stopReason === 'end_turn' || response.stopReason === 'max_turn_requests') {
        this.sessionManager.updateAgentState(issueKey, 'completed');
        this.appendEvent(issueKey, evt('task_complete', 'Agent completed the follow-up'));
      } else {
        this.sessionManager.updateAgentState(issueKey, 'failed');
        this.appendEvent(issueKey, evt('error', `Agent stopped: ${response.stopReason}`));
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
