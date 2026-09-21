import { randomUUID } from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk' with { 'resolution-mode': 'import' };
import type { AiProvider, IssueDetails } from '../../types';
import type { WireImageAttachment } from '../gateway/wire';
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
import { isProviderLimitError, extractProviderLimitMessage } from '../providerLimitError';

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
  /** Allow the agent's own tool-permission requests without asking (still bounded by `toolMode`). */
  autoApprovePermissions?: boolean;
  runtimeSessionId?: string;
  /**
   * HTTP MCP servers to expose to the agent for this session (e.g. the in-app
   * browser). Applied only when the agent advertises `mcpCapabilities.http`.
   */
  mcpServers?: AcpHttpMcpServer[];
  /** A host-scheduled AI-to-AI turn; do not persist its routing instruction as a user turn. */
  internalConversationTurn?: boolean;
  /** Host-supplied participant and handover context for an AI-to-AI or directed turn. */
  conversationContext?: string;
  /** Images pasted/dropped into the composer, riding alongside the follow-up prompt as ACP image content blocks. */
  images?: WireImageAttachment[];
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

/** How long a `session/cancel` notification is given before we stop waiting. */
const CANCEL_GRACE_MS = 3000;
/** How long an in-flight turn is given to unwind after cancel, before the child is killed anyway. */
const STOP_GRACE_MS = 5000;

/**
 * Awaits `work`, but gives up after `ms`. Used only where the alternative is an
 * unbounded wait on a subprocess that may never answer: the caller's next step
 * (disposing the client, which kills the child) is safe to take either way.
 */
async function settleWithin(work: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (!work) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.catch(() => {}),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function now(): string {
  return new Date().toISOString();
}

function evt(
  type: AgentEventType,
  summary: string,
  detail?: string,
  data?: AgentToolEventData,
  attachments?: WireImageAttachment[]
): AgentEventSummary {
  return {
    timestamp: now(),
    type,
    summary,
    detail,
    ...(data ? { data } : {}),
    ...(attachments?.length ? { attachments } : {})
  };
}

function isOpaquePermissionLabel(value: string, toolCallId: string): boolean {
  const normalized = value.trim();
  return !normalized
    || normalized === toolCallId
    || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(normalized)
    || /^[a-z0-9_-]{20,}$/i.test(normalized);
}

function permissionToolName(value: string | undefined, toolCallId: string): string | undefined {
  const normalized = value?.trim() ?? '';
  if (!normalized || isOpaquePermissionLabel(normalized, toolCallId) || /[\\/]/.test(normalized) || /^[.~]/.test(normalized) || /^[A-Za-z]:/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function permissionAction(request: AcpPermissionRequest): string {
  const kind = request.kind?.toLowerCase();
  switch (kind) {
    case 'read': return 'read a file or project resource';
    case 'edit': return 'edit a file';
    case 'delete': return 'delete a file or resource';
    case 'move': return 'move a file or resource';
    case 'search': return 'search the project';
    case 'execute': return 'execute a command or tool';
    case 'fetch': return 'fetch content from the internet';
    case 'switch_mode': return 'switch the agent mode';
    case 'think': return 'perform an extended reasoning step';
    default: return request.name?.trim() ? `run ${request.name.trim()}` : 'perform an agent action';
  }
}

function permissionDescription(request: AcpPermissionRequest): { summary: string; detail: string } {
  const action = permissionAction(request);
  const toolName = permissionToolName(request.name, request.toolCallId);
  return {
    summary: `Approval needed: ${toolName ?? action}`,
    detail: toolName
      ? `The agent is requesting permission to ${action} using ${toolName}.`
      : `The agent is requesting permission to ${action}.`
  };
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

async function applyAcpModel(client: AcpClientWrapper, model?: string): Promise<void> {
  if (!model) return;
  try {
    await client.setConfigOption('model', model);
  } catch {
    // Not every ACP agent exposes a model config option; the prompt still runs.
  }
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
      await client.shutdown();
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
      await applyAcpModel(client, options.model);
      await client.prompt(prompt);
      if (!content.trim()) {
        throw new Error('The CLI agent returned an empty response.');
      }
      return content.trim();
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      await client.shutdown();
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
      const description = permissionDescription(request);
      this.appendEvent(issueKey, evt('permission_requested', description.summary, description.detail));
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
      case 'plan': {
        // A stable ACP update (Claude Code's TodoWrite, Codex's plan tool land
        // here), silently dropped until now — this switch had no case for it.
        // Each one is a full snapshot per the spec ("the client replaces the
        // entire plan with each update"), so it replaces rather than merges.
        this.sessionManager.setAgentTaskList(
          issueKey,
          update.entries.map(entry => ({ content: entry.content, status: entry.status, priority: entry.priority }))
        );
        break;
      }
      case 'usage_update': {
        // `used` is tokens *currently in context*, not tokens consumed to date —
        // it maps to contextTokens/contextLimit, the pair that drives the
        // composer's context banner, and NOT to `tokenUsage`, which totals every
        // turn. ACP reports no cumulative token count, so a CLI-hosted session
        // still shows no token total; it does report a cumulative cost, which is
        // a different figure and is kept as one.
        this.sessionManager.setAgentContextUsage(issueKey, {
          contextTokens: update.used,
          contextLimit: update.size,
          ...(update.cost ? { cost: { amount: update.cost.amount, currency: update.cost.currency } } : {})
        });
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
      case 'available_commands_update': {
        // Stable, previously unhandled — the agent's own slash commands
        // (Claude Code's, Codex's). Praxis doesn't invoke these through a
        // dedicated RPC; they're plain prompt text (`/name args`), same as a
        // user would type them at the agent's own CLI. This just makes them
        // discoverable in the composer instead of requiring the user to
        // already know they exist.
        this.sessionManager.setAgentAvailableCommands(
          issueKey,
          update.availableCommands.map(command => ({
            name: command.name,
            description: command.description,
            inputHint: command.input?.hint
          }))
        );
        break;
      }
      case 'current_mode_update': {
        // Stable, previously unhandled. The agent can switch its own Session
        // Mode autonomously, not only in response to `setAcpMode` — this is
        // the client's only way to learn about that, so it's handled the same
        // whether it followed our own request or not.
        this.sessionManager.setAgentCurrentMode(issueKey, update.currentModeId);
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
      allowPermissionsForTask: options.autoApprovePermissions === true,
      messageBuffer: ''
    };
    this.activeTasks.set(issue.key, task);
    this.emitActiveTaskChange(issue.key);

    this.sessionManager.createAgentSession(issue.key, sessionId, taskDefinition, provider, options.model, {
      workingDirectory,
      toolMode
    });
    if (options.autoApprovePermissions) this.sessionManager.updateAgentRuntime(issue.key, { autoApprovePermissions: true });
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
      await applyAcpModel(client, options.model);
      // `session/new` triggers no prompt/completion of its own, so reading
      // modes here (rather than only reacting to `current_mode_update` later)
      // costs nothing and means the composer has something to show even
      // before the agent's first reply.
      const modes = await client.getSessionModes();
      if (modes) {
        this.sessionManager.setAgentAvailableModes(
          issue.key,
          modes.currentModeId,
          modes.availableModes.map(mode => ({ id: mode.id, name: mode.name, description: mode.description ?? undefined }))
        );
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
      // Record the reply as a conversation event, the same as a follow-up turn
      // does. Without this the agent's closing summary lived only in
      // `responseText`: it never appeared in the transcript the user reads, and
      // `buildConversationTranscript` — which reads `message` events — left the
      // agent's own first answer out of the next turn's prompt.
      if (active.messageBuffer) {
        this.appendEvent(issue.key, evt('message', 'Assistant', active.messageBuffer));
      }
      const isLimitInBuffer = isProviderLimitError(active.messageBuffer);
      if (isLimitInBuffer) {
        const limitNotice = extractProviderLimitMessage(active.messageBuffer);
        this.sessionManager.updateAgentState(issue.key, 'failed', limitNotice);
        this.appendEvent(issue.key, evt('error', limitNotice));
        return;
      }
      if (response.stopReason === 'end_turn' || response.stopReason === 'max_turn_requests') {
        this.sessionManager.updateAgentState(issue.key, 'completed');
        this.appendEvent(issue.key, evt('task_complete', 'Agent completed the task'));
        void this.sessionManager.refreshHandoverBrief(issue.key);
      } else if (response.stopReason === 'cancelled') {
        // abortTask already sets the terminal state.
      } else {
        const isLimit = isProviderLimitError(response.stopReason);
        const reason = isLimit ? extractProviderLimitMessage(response.stopReason) : `Agent stopped: ${response.stopReason}`;
        this.sessionManager.updateAgentState(issue.key, 'failed', reason);
        this.appendEvent(issue.key, evt('error', reason));
      }
    })()
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.appendLine(`[AcpAgent] Session failed for ${issue.key}: ${message}`);
        const record = this.sessionManager.getAgentSession(issue.key);
        if (record && !this.isTerminalState(record.state)) {
          const limitCandidate = isProviderLimitError(error)
            ? error
            : (task.messageBuffer && isProviderLimitError(task.messageBuffer))
              ? task.messageBuffer
              : (record.responseText && isProviderLimitError(record.responseText))
                ? record.responseText
                : undefined;
          const isLimit = Boolean(limitCandidate);
          const limitNotice = limitCandidate ? extractProviderLimitMessage(limitCandidate) : undefined;
          this.sessionManager.updateAgentState(issue.key, 'failed', limitNotice ?? message);
          this.appendEvent(issue.key, evt('error', limitNotice ?? message));
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
    const followUpImages = options.images;
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
    }${options.conversationContext ? `\n\n${options.conversationContext}` : ''}`;
    const prompt = [
      systemPrompt,
      this.buildConversationTranscript(record.events),
      `${options.internalConversationTurn ? 'Conversation routing instruction' : 'User follow-up'}:\n${followUp}`
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
      // A follow-up turn keeps the mode the session was started in.
      allowPermissionsForTask: record.autoApprovePermissions === true,
      messageBuffer: ''
    };
    this.activeTasks.set(issueKey, task);
    this.emitActiveTaskChange(issueKey);
    // The previous turn recorded its own reply when it ended, so there is
    // nothing to flush here. Re-appending `record.responseText` used to add a
    // second copy of a reply already in the events from the second follow-up on.
    // Clear the live buffer before publishing the follow-up so the previous
    // answer cannot briefly render after the new user message.
    this.sessionManager.updateAgentOutput(issueKey, { responseText: '' });
    this.appendEvent(
      issueKey,
      options.internalConversationTurn
        ? evt('conversation_turn', 'Conversation turn started')
        : evt('user_input_completed', 'You', followUp, undefined, followUpImages)
    );
    this.sessionManager.updateAgentState(issueKey, 'executing');

    task.promptPromise = (async () => {
      await client.connect();
      await applyAcpModel(client, options.model);
      const response = await client.prompt(prompt, followUpImages);
      if (client.sessionId) {
        this.sessionManager.updateAgentRuntime(issueKey, { runtimeSessionId: client.sessionId });
      }
      const active = this.activeTasks.get(issueKey);
      if (!active || active.ending) return;
      this.sessionManager.updateAgentOutput(issueKey, { responseText: active.messageBuffer });
      if (active.messageBuffer) this.appendEvent(issueKey, evt('message', 'Assistant', active.messageBuffer));
      const isLimitInBuffer = isProviderLimitError(active.messageBuffer);
      if (isLimitInBuffer) {
        const limitNotice = extractProviderLimitMessage(active.messageBuffer);
        this.sessionManager.updateAgentState(issueKey, 'failed', limitNotice);
        this.appendEvent(issueKey, evt('error', limitNotice));
        return;
      }
      if (response.stopReason === 'end_turn' || response.stopReason === 'max_turn_requests') {
        this.sessionManager.updateAgentState(issueKey, 'completed');
        this.appendEvent(issueKey, evt('task_complete', 'Agent completed the follow-up'));
        void this.sessionManager.refreshHandoverBrief(issueKey);
      } else {
        const isLimit = isProviderLimitError(response.stopReason);
        const reason = isLimit ? extractProviderLimitMessage(response.stopReason) : `Agent stopped: ${response.stopReason}`;
        this.sessionManager.updateAgentState(issueKey, 'failed', reason);
        this.appendEvent(issueKey, evt('error', reason));
      }
    })().catch(error => {
      const text = error instanceof Error ? error.message : String(error);
      this.logger.appendLine(`[AcpAgent] Follow-up failed for ${issueKey}: ${text}`);
      const record = this.sessionManager.getAgentSession(issueKey);
      const limitCandidate = isProviderLimitError(error)
        ? error
        : (task.messageBuffer && isProviderLimitError(task.messageBuffer))
          ? task.messageBuffer
          : (record?.responseText && isProviderLimitError(record.responseText))
            ? record.responseText
            : undefined;
      const isLimit = Boolean(limitCandidate);
      const limitNotice = limitCandidate ? extractProviderLimitMessage(limitCandidate) : undefined;
      this.sessionManager.updateAgentState(issueKey, 'failed', limitNotice ?? text);
      this.appendEvent(issueKey, evt('error', limitNotice ?? text));
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

  /**
   * Switches the agent's own Session Mode via `session/set_mode`. Only
   * meaningful while a task is active — there's no ACP connection to send it
   * over otherwise, since a resumed follow-up turn opens a fresh one.
   * Updates the record optimistically on success rather than waiting for the
   * `current_mode_update` echo, since not every agent sends one for a change
   * it was explicitly asked to make.
   */
  public async setAcpMode(issueKey: string, modeId: string): Promise<void> {
    const task = this.activeTasks.get(issueKey);
    if (!task || task.ending) {
      throw new Error(`No active agent session for ${issueKey}.`);
    }
    await task.client.setMode(modeId);
    this.sessionManager.setAgentCurrentMode(issueKey, modeId);
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
      // A second stop while the first is draining must not block on a turn that
      // may never settle — the first caller owns the cleanup either way.
      await settleWithin(task.promptPromise, STOP_GRACE_MS);
      return;
    }
    task.ending = true;
    for (const pending of task.pendingPermissions.splice(0)) {
      pending.resolve('deny');
    }
    // Ask politely, then stop waiting. `cancel()` is a notification to a process
    // that may already be wedged, and `cleanupTask`'s `dispose()` kills the child
    // regardless — so a slow or ignored cancel must never hold the caller.
    await settleWithin(task.client.cancel().catch(() => {}), CANCEL_GRACE_MS);
    await settleWithin(task.promptPromise, STOP_GRACE_MS);

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
    await task.client.shutdown();
    this.activeTasks.delete(issueKey);
    this.emitActiveTaskChange(issueKey);
  }
}
