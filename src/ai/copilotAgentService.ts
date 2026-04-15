import * as vscode from 'vscode';
import type { IssueDetails } from '../types';
import type { AiSessionManager } from './aiSessionManager';
import type {
  AgentEventSummary,
  AgentEventType,
  AgentTaskDefinition
} from './agentTypes';
import { AGENT_DEFAULTS } from './agentTypes';
import { resolveCopilotClientOptions } from './copilotSdkRuntime';

interface ActiveTask {
  issueKey: string;
  client: { stop(): Promise<unknown> };
  session: {
    sessionId: string;
    send(options: { prompt: string }): Promise<unknown>;
    sendAndWait(options: { prompt: string }, timeout?: number): Promise<{ data?: Record<string, unknown> } | undefined>;
    on(handler: (event: { type: string; data?: Record<string, unknown> }) => void): () => void;
    abort(): Promise<void>;
    disconnect(): Promise<void>;
  };
  unsubscribes: Array<() => void>;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  /** Pending permission prompts awaiting a user response. */
  pendingPermissions: Array<{
    description: string;
    kind: string;
    detail?: string;
    resolve: (
      result: 'allow_once' | 'allow_always' | 'deny',
      options?: {
        silent?: boolean;
      }
    ) => void;
  }>;
  /** Resolvers for pending user-input requests. */
  pendingInput?: {
    resolve: (
      response: string,
      options?: {
        silent?: boolean;
      }
    ) => void;
  };
  allowPermissionsForTask: boolean;
  messageBuffers: Map<string, string>;
  reasoningBuffers: Map<string, string>;
  toolNames: Map<string, string>;
  ending?: boolean;
  stopPromise?: Promise<void>;
  maxSteps: number;
  stepLimitWarned?: boolean;
  stepLimitPromptInFlight?: boolean;
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

function slugifyNamingSegment(value: string): string {
  return value
    .normalize('NFKD')
    .replaceAll(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
}

function stripIssueKeyPrefix(value: string, issueKey: string): string {
  const normalizedIssueKey = slugifyNamingSegment(issueKey);
  if (!value || !normalizedIssueKey) {
    return value;
  }
  if (value === normalizedIssueKey) {
    return '';
  }
  if (value.startsWith(`${normalizedIssueKey}-`)) {
    return value.slice(normalizedIssueKey.length + 1);
  }
  return value;
}

export function buildWorktreeName(issue: Pick<IssueDetails, 'key' | 'summary' | 'branch'>): string {
  const source = issue.summary || issue.branch?.trim() || issue.key;
  const normalizedSource = stripIssueKeyPrefix(slugifyNamingSegment(source), issue.key);
  const suffix = normalizedSource.slice(0, 48).replaceAll(/-+$/g, '') || 'work-item';
  return `${issue.key}-${suffix}`;
}

export function buildMsiVersionExample(
  issueKey: string,
  baseVersion = '1.0.0.1',
  buildIdentifier = 'buildx'
): string {
  return `${baseVersion}-${issueKey}-${buildIdentifier}`;
}

export function buildSystemPrompt(task: AgentTaskDefinition, issue: IssueDetails): string {
  const workflow = task.workflow
    ? [
        '\n## Assigned Workflow Pack',
        `- Name: ${task.workflow.name}`,
        `- Instructions file: ${task.workflow.instructionsPath}`,
        task.workflow.description ? `- Description: ${task.workflow.description}` : undefined,
        task.workflow.link ? `- Reference link: ${task.workflow.link}` : undefined,
        '- Treat this workflow pack as the execution playbook for this task.',
        '- Read the instructions file before taking implementation actions.',
        '- Follow the workflow ordering, sub-agent choices, and review gates unless they conflict with explicit user instructions or this task contract.'
      ].filter((line): line is string => Boolean(line)).join('\n')
    : '';
  const attachments = task.attachments?.length
    ? [
        '\n## Issue Attachments',
        '- The following issue attachments were downloaded locally before execution.',
        '- Review any relevant screenshots, mockups, specs, or supporting files before implementation.',
        ...task.attachments.map(attachment =>
          [
            `- ${attachment.fileName}: ${attachment.localPath}`,
            attachment.mediaType ? `  media type: ${attachment.mediaType}` : undefined,
            typeof attachment.sizeBytes === 'number' ? `  size bytes: ${attachment.sizeBytes}` : undefined,
            attachment.sourceUrl ? `  source: ${attachment.sourceUrl}` : undefined
          ].filter((line): line is string => Boolean(line)).join('\n')
        )
      ].join('\n')
    : '';
  const nonGoals = task.nonGoals?.length
    ? `\n## Non-Goals (do NOT touch)\n${task.nonGoals.map(g => `- ${g}`).join('\n')}`
    : '';
  const completionContract = task.completionContract?.trim()
    ? `\n## Completion Contract\n${task.completionContract.trim()}`
    : '';
  const worktreeName = buildWorktreeName(issue);
  const msiVersionExample = buildMsiVersionExample(issue.key);

  return `${PLANNING_SYSTEM_PROMPT}
## Task
**Goal:** ${task.goal}
**Scope:** ${task.scope}
**Definition of Done:** ${task.definitionOfDone}
${workflow}
${attachments}
${nonGoals}
${completionContract}

## Issue Context
- Key: ${issue.key}
- Summary: ${issue.summary}
- Type: ${issue.issueType}
- Status: ${issue.status}
${issue.description ? `- Description:\n${issue.description.slice(0, 4000)}` : ''}

## Execution Conventions
- If you create a git worktree, its name MUST start with ${issue.key}.
- Use a worktree name like: ${worktreeName}
- If you publish a new MSI, keep the base version and append -${issue.key}-<build-id>.
- Use an MSI version like: ${msiVersionExample}
- Do not publish a generic MSI artifact name or version that omits the Jira issue key.
`;
}

function now(): string {
  return new Date().toISOString();
}

function evt(type: AgentEventType, summary: string, detail?: string): AgentEventSummary {
  return { timestamp: now(), type, summary, detail };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isSessionIdleTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /waiting for session\.idle/i.test(message);
}

export interface PermissionInfo {
  description: string;
  kind: string;
  detail?: string;
}

function formatPermissionDescription(request: { kind?: string; [key: string]: unknown }): PermissionInfo {
  const kind = asString(request.kind) ?? 'unknown';
  const fileName = asString(request.fileName);
  const toolName = asString(request.toolName);
  const command = asString(request.fullCommandText);
  const url = asString(request.url);

  switch (kind) {
    case 'read':
      return { kind, detail: fileName, description: fileName ? `Permission requested: read ${fileName}` : 'Permission requested: read' };
    case 'write':
      return { kind, detail: fileName, description: fileName ? `Permission requested: write ${fileName}` : 'Permission requested: write' };
    case 'shell':
      return { kind, detail: command, description: command ? `Permission requested: shell ${command}` : 'Permission requested: shell' };
    case 'mcp':
    case 'custom-tool':
      return { kind, detail: toolName, description: toolName ? `Permission requested: ${kind} ${toolName}` : `Permission requested: ${kind}` };
    case 'url':
      return { kind, detail: url, description: url ? `Permission requested: fetch ${url}` : 'Permission requested: url' };
    default:
      return { kind, detail: undefined, description: `Permission requested: ${kind}` };
  }
}

function normalizeShellSegment(segment: string): string {
  return segment.replaceAll(/\s+/g, ' ').trim();
}

function isDirectoryChangeSegment(segment: string): boolean {
  const normalized = normalizeShellSegment(segment).toLowerCase();
  return normalized.startsWith('cd ') || normalized.startsWith('set-location ') || normalized.startsWith('push-location ');
}

function isSafeShellProbeSegment(segment: string): boolean {
  const normalized = normalizeShellSegment(segment);
  const patterns = [
    /^dotnet\s+--version(?:\s+2>&1)?$/i,
    /^node\s+--version(?:\s+2>&1)?$/i,
    /^npm\s+--version(?:\s+2>&1)?$/i,
    /^git\s+--version(?:\s+2>&1)?$/i,
    /^python(?:3)?\s+--version(?:\s+2>&1)?$/i,
    /^where(?:\.exe)?\s+(?:dotnet|node|npm|git|python(?:3)?)(?:\s+2>&1)?$/i,
    /^(?:pwd|get-location)(?:\s+2>&1)?$/i
  ];
  return patterns.some(pattern => pattern.test(normalized));
}

function isSafeGitInspectionSegment(segment: string): boolean {
  const normalized = normalizeShellSegment(segment);
  const patterns = [
    /^git\s+(?:--no-pager\s+)?status(?:\s+.*)?$/i,
    /^git\s+(?:--no-pager\s+)?branch(?:\s+.*)?$/i,
    /^git\s+(?:--no-pager\s+)?log(?:\s+.*)?$/i,
    /^git\s+(?:--no-pager\s+)?diff(?:\s+.*)?$/i,
    /^git\s+(?:--no-pager\s+)?show(?:\s+.*)?$/i,
    /^git\s+rev-parse(?:\s+.*)?$/i,
    /^git\s+symbolic-ref(?:\s+.*)?$/i,
    /^git\s+describe(?:\s+.*)?$/i,
    /^git\s+ls-files(?:\s+.*)?$/i,
    /^git\s+remote\s+-v$/i,
    /^git\s+remote\s+show(?:\s+.*)?$/i,
    /^git\s+tag(?:\s+--list|\s+-l)?(?:\s+.*)?$/i,
    /^git\s+stash\s+list(?:\s+.*)?$/i,
    /^git\s+config\s+--get(?:-all)?(?:\s+.*)?$/i,
    /^git\s+merge-base(?:\s+.*)?$/i,
    /^git\s+submodule\s+status(?:\s+.*)?$/i
  ];
  return patterns.some(pattern => pattern.test(normalized));
}

function isSafeBuildShellSegment(segment: string): boolean {
  const normalized = normalizeShellSegment(segment);
  const powershellScriptMatch = /^(?:pwsh|powershell)(?:\.exe)?\s+.+?-file\s+(?<script>[^\s]+)(?:\s+.*)?$/i.exec(normalized);
  if (powershellScriptMatch?.groups?.script) {
    const scriptPath = powershellScriptMatch.groups.script.replaceAll(/^['"]|['"]$/g, '').toLowerCase();
    if (
      scriptPath.includes('build') ||
      scriptPath.includes('publish') ||
      scriptPath.includes('package') ||
      scriptPath.includes('test') ||
      scriptPath.includes('install')
    ) {
      return true;
    }
  }

  const patterns = [
    /^dotnet\s+(?:build|publish|test|pack|restore|msbuild|clean|workload\s+restore)(?:\s+.*)?$/i,
    /^msbuild(?:\.exe)?\s+.+$/i,
    /^npm\s+(?:build|compile|package|pack|test|ci)(?:\s+.*)?$/i,
    /^npm\s+run\s+(?:build|compile|package|pack|test|ci)(?:\s+.*)?$/i,
    /^npm\s+(?:install(?::[\w:-]+)|run\s+install(?::[\w:-]+))(?:\s+.*)?$/i,
    /^npx\s+.+$/i,
    /^(?:candle|light|heat|wix)(?:\.exe)?\s+.+$/i,
    /^nuget(?:\.exe)?\s+(?:restore|pack)(?:\s+.*)?$/i
  ];
  return patterns.some(pattern => pattern.test(normalized));
}

function shouldSilentlyApprovePermissionRequest(request: { kind?: string; [key: string]: unknown }): boolean {
  if (asString(request.kind) !== 'shell') {
    return false;
  }

  const command = asString(request.fullCommandText)?.trim();
  if (!command) {
    return false;
  }

  const segments = command.split('&&').map(segment => segment.trim()).filter(segment => segment.length > 0);
  if (segments.length === 0) {
    return false;
  }

  return segments.every(segment =>
    isDirectoryChangeSegment(segment) ||
    isSafeShellProbeSegment(segment) ||
    isSafeGitInspectionSegment(segment) ||
    isSafeBuildShellSegment(segment)
  );
}

export interface CopilotAgentLogger {
  appendLine(message: string): void;
}

export class CopilotAgentService {
  private readonly activeTasks = new Map<string, ActiveTask>();
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

  private buildClientOptions(cliPath: string | undefined): {
    cliPath?: string;
    env?: NodeJS.ProcessEnv;
  } {
    const resolved = resolveCopilotClientOptions(cliPath);
    if (resolved.warning) {
      this.logger.appendLine(`[Copilot SDK] ${resolved.warning}`);
    }
    return resolved.clientOptions;
  }

  private emitActiveTaskChange(issueKey: string): void {
    for (const listener of this.activeTaskListeners) {
      try {
        listener(issueKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.appendLine(`[Agent] Active task listener failed for ${issueKey}: ${message}`);
      }
    }
  }

  private isTerminalState(state: string | undefined): boolean {
    return state === 'completed' || state === 'failed' || state === 'aborted';
  }

  /** Start a new Copilot agent task for an issue. */
  public async startTask(
    issue: IssueDetails,
    taskDefinition: AgentTaskDefinition,
    options: { cliPath?: string; workingDirectory?: string }
  ): Promise<string> {
    // Abort any existing task for this issue
    if (this.activeTasks.has(issue.key)) {
      await this.abortTask(issue.key);
    }

    const sdk = await import('@github/copilot-sdk');
    const client = new sdk.CopilotClient(this.buildClientOptions(options.cliPath));
    await client.start();

    const maxSteps = taskDefinition.maxSteps ?? AGENT_DEFAULTS.maxSteps;
    const timeoutMs = taskDefinition.timeoutMs ?? AGENT_DEFAULTS.timeoutMs;
    const sendAndWaitTimeoutMs = timeoutMs + 5000;

    const systemPrompt = buildSystemPrompt(taskDefinition, issue);

    // Pre-register task stub so permission/input handlers can find it immediately
    const task: ActiveTask = {
      issueKey: issue.key,
      client,
      session: undefined!, // populated after createSession
      unsubscribes: [],
      pendingPermissions: [],
      messageBuffers: new Map<string, string>(),
      reasoningBuffers: new Map<string, string>(),
      allowPermissionsForTask: false,
      toolNames: new Map<string, string>(),
      maxSteps
    };
    this.activeTasks.set(issue.key, task);
    this.emitActiveTaskChange(issue.key);

    let session: ActiveTask['session'];
    try {
      const hooks = this.createInteractiveSessionHooks(issue.key);
      session = await client.createSession({
        clientName: 'ticket-manager-agent',
        infiniteSessions: { enabled: true },
        streaming: true,
        systemMessage: { content: systemPrompt },
        workingDirectory: options.workingDirectory,
        ...hooks
      });
    } catch (err) {
      // Clean up client if session creation fails
      this.activeTasks.delete(issue.key);
      this.emitActiveTaskChange(issue.key);
      try { await client.stop(); } catch { /* best-effort */ }
      throw err;
    }

    task.session = session;

    // Create persisted record
    this.sessionManager.createAgentSession(issue.key, session.sessionId, taskDefinition);

    // Subscribe to session events
    const unsubAll = session.on((event) => {
      this.handleSessionEvent(issue.key, event);
    });
    task.unsubscribes.push(unsubAll);

    // Timeout watchdog
    task.timeoutHandle = setTimeout(() => {
      void this.failTaskForTimeout(issue.key, timeoutMs);
    }, timeoutMs);

    // Transition to planning and send initial prompt
    this.sessionManager.updateAgentState(issue.key, 'planning');
    this.appendEvent(issue.key, evt('session_start', 'Copilot agent session started'));

    const initialPrompt = `Execute the task described in the system prompt. Start by producing a step-by-step plan, then execute it.

Issue: ${issue.key} — ${issue.summary}`;
    this.logger.appendLine(
      `[Agent] Timers for ${issue.key}: task=${timeoutMs}ms final-wait=${sendAndWaitTimeoutMs}ms`
    );

    // Fire and don't await — the event stream will track progress while this
    // provides a final success/failure backstop if the runtime exits quietly.
    session.sendAndWait({ prompt: initialPrompt }, sendAndWaitTimeoutMs).then(finalMessage => {
      const record = this.sessionManager.getAgentSession(issue.key);
      if (!this.activeTasks.has(issue.key) || !record || this.isTerminalState(record.state)) {
        return;
      }

      const finalContent = asString(finalMessage?.data?.content);
      const finalReasoning = asString(finalMessage?.data?.reasoningText);
      if (finalContent || finalReasoning) {
        this.sessionManager.updateAgentOutput(
          issue.key,
          {
            responseText: finalContent ?? record.responseText,
            reasoningText: finalReasoning ?? record.reasoningText
          },
          { persist: false }
        );
      }

      this.sessionManager.updateAgentState(issue.key, 'completed');
      this.appendEvent(issue.key, evt('task_complete', 'Task complete'));
      void this.cleanupTask(issue.key);
    }).catch((err: Error) => {
      const record = this.sessionManager.getAgentSession(issue.key);
      if (!this.activeTasks.has(issue.key) || (record && this.isTerminalState(record.state))) {
        return;
      }
      if (isSessionIdleTimeoutError(err)) {
        this.logger.appendLine(
          `[Agent] Final wait timed out for ${issue.key}; continuing to rely on live session events and task watchdog`
        );
        this.appendEvent(
          issue.key,
          evt('warning', 'Final wait timed out; task is still being tracked by live session events.')
        );
        return;
      }
      this.logger.appendLine(`[Agent] Task run failed for ${issue.key}: ${err.message}`);
      this.sessionManager.updateAgentState(issue.key, 'failed');
      this.appendEvent(issue.key, evt('error', `Task failed: ${err.message}`));
      void this.cleanupTask(issue.key);
    });

    this.logger.appendLine(`[Agent] Started task for ${issue.key} (session ${session.sessionId})`);
    return session.sessionId;
  }

  /** Resume a previously disconnected session. */
  public async resumeTask(
    issueKey: string,
    options: { cliPath?: string; workingDirectory?: string }
  ): Promise<void> {
    if (this.activeTasks.has(issueKey)) {
      this.logger.appendLine(`[Agent] Session for ${issueKey} is already active.`);
      return;
    }

    const record = this.sessionManager.getAgentSession(issueKey);
    if (!record) {
      throw new Error(`No agent session found for ${issueKey}`);
    }

    const sdk = await import('@github/copilot-sdk');
    const client = new sdk.CopilotClient(this.buildClientOptions(options.cliPath));
    await client.start();

    const maxSteps = record.taskDefinition.maxSteps ?? AGENT_DEFAULTS.maxSteps;
    const timeoutMs = record.taskDefinition.timeoutMs ?? AGENT_DEFAULTS.timeoutMs;
    const hooks = this.createInteractiveSessionHooks(issueKey);
    let session: ActiveTask['session'];
    try {
      session = await client.resumeSession(record.sessionId, {
        ...hooks,
        streaming: true,
        workingDirectory: options.workingDirectory
      });
    } catch (error) {
      try {
        await client.stop();
      } catch {
        // Best-effort cleanup
      }
      throw error;
    }

    const task: ActiveTask = {
      issueKey,
      client,
      session,
      unsubscribes: [],
      pendingPermissions: [],
      messageBuffers: new Map<string, string>(record.responseText ? [['history', record.responseText]] : []),
      reasoningBuffers: new Map<string, string>(record.reasoningText ? [['history', record.reasoningText]] : []),
      allowPermissionsForTask: false,
      toolNames: new Map<string, string>(),
      maxSteps
    };
    this.activeTasks.set(issueKey, task);
    this.emitActiveTaskChange(issueKey);

    const unsub = session.on((event) => {
      this.handleSessionEvent(issueKey, event);
    });
    task.unsubscribes.push(unsub);

    task.timeoutHandle = setTimeout(() => {
      void this.failTaskForTimeout(issueKey, timeoutMs);
    }, timeoutMs);

    this.sessionManager.updateAgentState(issueKey, 'executing');
    this.appendEvent(issueKey, evt('session_start', 'Session resumed'));
    this.logger.appendLine(`[Agent] Resumed session for ${issueKey}`);
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
      if (!task.pendingInput) {
        this.sessionManager.updateAgentState(issueKey, 'executing');
      }
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
      this.appendEvent(
        issueKey,
        evt(
          'info',
          `${task.pendingPermissions.length} permission request${task.pendingPermissions.length === 1 ? '' : 's'} still pending`
        )
      );
      return;
    }

    if (!task.pendingInput) {
      this.sessionManager.updateAgentState(issueKey, 'executing');
    }
  }

  public getPendingPermissionDescriptions(issueKey: string): string[] {
    const task = this.activeTasks.get(issueKey);
    if (!task || task.pendingPermissions.length === 0) {
      return [];
    }

    return task.pendingPermissions.map(request => request.description);
  }

  public getPendingPermissions(issueKey: string): PermissionInfo[] {
    const task = this.activeTasks.get(issueKey);
    if (!task || task.pendingPermissions.length === 0) {
      return [];
    }
    return task.pendingPermissions.map(request => ({
      description: request.description,
      kind: request.kind,
      detail: request.detail
    }));
  }

  /** Abort a running agent task. */
  public async abortTask(issueKey: string): Promise<void> {
    await this.stopTask(issueKey, {
      terminalState: 'aborted',
      event: evt('aborted', 'Task aborted by user'),
      logLine: `[Agent] Aborted task for ${issueKey}`
    });
  }

  /** Check if an issue has an active in-memory task. */
  public hasActiveTask(issueKey: string): boolean {
    return this.activeTasks.has(issueKey);
  }

  public getActiveTaskIssueKeys(): string[] {
    return [...this.activeTasks.keys()];
  }

  public async pauseTask(issueKey: string, reason?: string): Promise<void> {
    await this.stopTask(issueKey, {
      terminalState: 'paused',
      event: evt('info', reason ?? 'Session paused.'),
      logLine: `[Agent] Paused task for ${issueKey}`,
      abortSession: false
    });
  }

  public async pauseAllTasks(reason?: string): Promise<void> {
    const issueKeys = [...this.activeTasks.keys()];
    for (const issueKey of issueKeys) {
      await this.pauseTask(issueKey, reason ?? 'Session paused.');
    }
  }

  public dispose(): void {
    void this.pauseAllTasks('Session paused because Ticket Manager was shut down.');
  }

  private async failTaskForTimeout(issueKey: string, timeoutMs: number): Promise<void> {
    await this.stopTask(issueKey, {
      terminalState: 'failed',
      event: evt(
        'error',
        `Task stopped after timing out at ${Math.round(timeoutMs / 1000)}s. Start a new session to continue.`
      ),
      logLine: `[Agent] Timeout reached for ${issueKey} (${timeoutMs}ms)`
    });
  }

  private async failTaskForStepLimit(issueKey: string, maxSteps: number): Promise<void> {
    await this.stopTask(issueKey, {
      terminalState: 'failed',
      event: evt(
        'error',
        `Task stopped after reaching the tool step limit (${maxSteps}). Start a new session to continue.`
      ),
      logLine: `[Agent] Max steps (${maxSteps}) reached for ${issueKey}`
    });
  }

  private async promptForStepLimitExtension(issueKey: string): Promise<void> {
    const task = this.activeTasks.get(issueKey);
    if (!task || task.ending || task.stepLimitPromptInFlight) {
      return;
    }
    task.stepLimitPromptInFlight = true;

    const stepIncrement = AGENT_DEFAULTS.maxSteps;
    const choice = await vscode.window.showWarningMessage(
      `${issueKey}: Step limit reached (${task.maxSteps}). The agent is paused.`,
      `Continue (+${stepIncrement} steps)`,
      'Continue (no limit)',
      'Stop'
    );

    // Re-check task is still active after the async prompt
    const current = this.activeTasks.get(issueKey);
    if (!current || current !== task) {
      return;
    }
    task.stepLimitPromptInFlight = false;

    if (choice === `Continue (+${stepIncrement} steps)`) {
      task.maxSteps += stepIncrement;
      task.stepLimitWarned = false;
      this.appendEvent(
        issueKey,
        evt('info', `Step limit extended to ${task.maxSteps}`)
      );
      this.logger.appendLine(`[Agent] Step limit extended to ${task.maxSteps} for ${issueKey}`);
    } else if (choice === 'Continue (no limit)') {
      task.maxSteps = Number.MAX_SAFE_INTEGER;
      task.stepLimitWarned = false;
      this.appendEvent(issueKey, evt('info', 'Step limit removed — agent will run until complete'));
      this.logger.appendLine(`[Agent] Step limit removed for ${issueKey}`);
    } else {
      // "Stop" or dismissed
      await this.failTaskForStepLimit(issueKey, task.maxSteps);
    }
  }

  private async stopTask(
    issueKey: string,
    options: {
      terminalState: 'aborted' | 'failed' | 'paused';
      event: AgentEventSummary;
      logLine: string;
      abortSession?: boolean;
    }
  ): Promise<void> {
    const task = this.activeTasks.get(issueKey);
    if (!task) {
      return;
    }

    if (task.stopPromise) {
      await task.stopPromise;
      return;
    }

    task.ending = true;
    task.stopPromise = (async () => {
      const record = this.sessionManager.getAgentSession(issueKey);
      const shouldRecordOutcome = !record || !this.isTerminalState(record.state);

      if (record && shouldRecordOutcome) {
        this.sessionManager.updateAgentState(issueKey, options.terminalState);
      }
      if (shouldRecordOutcome) {
        this.appendEvent(issueKey, options.event);
      }

      if (options.abortSession ?? true) {
        try {
          await task.session.abort();
        } catch {
          // Best-effort abort
        }
      }

      await this.cleanupTask(issueKey);
      this.logger.appendLine(options.logLine);
    })();

    await task.stopPromise;
  }

  // ── Event Handling ─────────────────────────────────────────────

  private handleSessionEvent(
    issueKey: string,
    event: { type: string; data?: Record<string, unknown> }
  ): void {
    const data = event.data ?? {};
    const task = this.activeTasks.get(issueKey);
    const maxSteps = task?.maxSteps ?? AGENT_DEFAULTS.maxSteps;
    const currentRecord = this.sessionManager.getAgentSession(issueKey);
    if (task?.ending || (currentRecord && this.isTerminalState(currentRecord.state))) {
      return;
    }

    switch (event.type) {
      case 'assistant.intent':
        this.appendEvent(issueKey, evt('intent', `Intent: ${data.content ?? ''}`));
        break;

      case 'assistant.reasoning_delta': {
        if (!task) {
          break;
        }
        const reasoningId = asString(data.reasoningId) ?? 'reasoning';
        const deltaContent = asString(data.deltaContent) ?? '';
        if (!deltaContent) {
          break;
        }
        const previous = task.reasoningBuffers.get(reasoningId) ?? '';
        task.reasoningBuffers.set(reasoningId, previous + deltaContent);
        this.syncLiveOutput(issueKey, task, { persist: false });
        break;
      }

      case 'assistant.reasoning': {
        if (!task) {
          break;
        }
        const reasoningId = asString(data.reasoningId) ?? 'reasoning';
        const content = asString(data.content) ?? '';
        task.reasoningBuffers.set(reasoningId, content);
        this.syncLiveOutput(issueKey, task);
        if (content) {
          const preview = content.length > 160 ? `${content.slice(0, 160)}…` : content;
          this.appendEvent(issueKey, evt('reasoning', preview, content));
        }
        break;
      }

      case 'assistant.message_delta': {
        if (!task) {
          break;
        }
        const messageId = asString(data.messageId) ?? 'message';
        const deltaContent = asString(data.deltaContent) ?? '';
        if (!deltaContent) {
          break;
        }
        const previous = task.messageBuffers.get(messageId) ?? '';
        const next = previous + deltaContent;
        task.messageBuffers.set(messageId, next);
        this.syncLiveOutput(issueKey, task, { persist: false });

        const record = this.sessionManager.getAgentSession(issueKey);
        if (record?.state === 'planning' && next.length > 0) {
          this.sessionManager.setAgentPlan(issueKey, next, { persist: false });
        }
        break;
      }

      case 'assistant.message': {
        const content = asString(data.content) ?? '';
        if (task) {
          const messageId = asString(data.messageId) ?? `message-${task.messageBuffers.size + 1}`;
          task.messageBuffers.set(messageId, content);
          const reasoningText = asString(data.reasoningText);
          if (reasoningText) {
            task.reasoningBuffers.set(`message-reasoning-${messageId}`, reasoningText);
          }
          this.syncLiveOutput(issueKey, task);
        }
        const toolRequestCount = Array.isArray(data.toolRequests) ? data.toolRequests.length : 0;
        const preview = content.length > 0
          ? (content.length > 200 ? `${content.slice(0, 200)}…` : content)
          : toolRequestCount > 0
            ? `Assistant requested ${toolRequestCount} tool action${toolRequestCount === 1 ? '' : 's'}`
            : 'Assistant produced an empty message';
        this.appendEvent(issueKey, evt('message', preview, content || undefined));

        // Capture first message as plan if still in planning state
        const record = this.sessionManager.getAgentSession(issueKey);
        if (record?.state === 'planning' && content.length > 0) {
          this.sessionManager.setAgentPlan(issueKey, content);
          this.sessionManager.updateAgentState(issueKey, 'executing');
        }
        break;
      }

      case 'session.plan_changed': {
        const plan = asString(data.plan) ?? JSON.stringify(data);
        this.sessionManager.setAgentPlan(issueKey, plan);
        this.appendEvent(issueKey, evt('plan', 'Plan updated'));
        break;
      }

      case 'tool.execution_start': {
        const toolCallId = asString(data.toolCallId) ?? '';
        const name = asString(data.toolName) ?? asString(data.mcpToolName) ?? 'unknown';
        if (toolCallId) {
          task?.toolNames.set(toolCallId, name);
        }
        this.appendEvent(issueKey, evt('tool_start', `Running tool: ${name}`));
        break;
      }

      case 'tool.execution_complete': {
        const toolCallId = asString(data.toolCallId) ?? '';
        const name = (toolCallId && task?.toolNames.get(toolCallId)) || 'unknown';
        const success = data.success !== false;
        const result = data.result;
        const detailedContent = result && typeof result === 'object'
          ? asString((result as Record<string, unknown>).detailedContent) ?? asString((result as Record<string, unknown>).content)
          : undefined;
        const error = data.error && typeof data.error === 'object'
          ? asString((data.error as Record<string, unknown>).message)
          : undefined;
        this.appendEvent(
          issueKey,
          evt(
            'tool_complete',
            `Tool ${success ? 'completed' : 'failed'}: ${name}`,
            error ?? detailedContent
          ),
          1
        );
        if (toolCallId) {
          task?.toolNames.delete(toolCallId);
        }

        // Guardrail: max step count — warn at 80%, prompt at limit
        const rec = this.sessionManager.getAgentSession(issueKey);
        if (rec && task) {
          const warningThreshold = Math.floor(task.maxSteps * 0.8);
          if (!task.stepLimitWarned && rec.stepCount >= warningThreshold) {
            task.stepLimitWarned = true;
            this.appendEvent(
              issueKey,
              evt('warning', `Approaching step limit: ${rec.stepCount}/${task.maxSteps} steps used`)
            );
          }
          if (rec.stepCount >= task.maxSteps) {
            void this.promptForStepLimitExtension(issueKey);
          }
        }
        break;
      }

      case 'tool.execution_progress': {
        const toolCallId = asString(data.toolCallId) ?? '';
        const name = (toolCallId && task?.toolNames.get(toolCallId)) || 'unknown';
        const progressMessage = asString(data.progressMessage) ?? 'Tool is still running';
        this.appendEvent(issueKey, evt('info', `${name}: ${progressMessage}`));
        break;
      }

      case 'session.idle': {
        const record = this.sessionManager.getAgentSession(issueKey);
        if (
          record &&
          !this.isTerminalState(record.state) &&
          (task?.pendingPermissions.length ?? 0) === 0 &&
          !task?.pendingInput
        ) {
          this.sessionManager.updateAgentState(issueKey, 'completed');
          this.appendEvent(issueKey, evt('idle', 'Session idle — task complete'));
          void this.cleanupTask(issueKey);
        }
        break;
      }

      case 'session.task_complete': {
        const summary = asString(data.summary) ?? 'Task complete';
        this.sessionManager.updateAgentState(issueKey, 'completed');
        this.appendEvent(issueKey, evt('task_complete', summary));
        void this.cleanupTask(issueKey);
        break;
      }

      case 'session.error': {
        const message = asString(data.message) ?? 'Unknown error';
        this.sessionManager.updateAgentState(issueKey, 'failed');
        this.appendEvent(issueKey, evt('error', `Error: ${message}`));
        void this.cleanupTask(issueKey);
        break;
      }

      case 'session.info': {
        const msg = asString(data.message) ?? '';
        if (msg) {
          this.appendEvent(issueKey, evt('info', msg));
        }
        break;
      }

      case 'session.warning': {
        const msg = asString(data.message) ?? '';
        if (msg) {
          this.appendEvent(issueKey, evt('warning', `Warning: ${msg}`));
        }
        break;
      }

      case 'session.shutdown': {
        const record = this.sessionManager.getAgentSession(issueKey);
        if (!record || this.isTerminalState(record.state)) {
          break;
        }

        const shutdownType = asString(data.shutdownType) ?? 'routine';
        const errorReason = asString(data.errorReason);
        const summary = shutdownType === 'error'
          ? `Session runtime stopped unexpectedly${errorReason ? `: ${errorReason}` : '.'}`
          : 'Session runtime disconnected before task completion.';
        this.sessionManager.updateAgentState(issueKey, 'failed');
        this.appendEvent(issueKey, evt('error', summary, errorReason));
        void this.cleanupTask(issueKey);
        break;
      }
    }
  }

  private syncLiveOutput(
    issueKey: string,
    task: ActiveTask,
    options?: {
      persist?: boolean;
    }
  ): void {
    this.sessionManager.updateAgentOutput(
      issueKey,
      {
        reasoningText: this.joinStreamingBuffers(task.reasoningBuffers),
        responseText: this.joinStreamingBuffers(task.messageBuffers)
      },
      options
    );
  }

  private joinStreamingBuffers(buffers: Map<string, string>): string | undefined {
    const chunks = [...buffers.values()].filter(value => value.trim().length > 0);
    return chunks.length ? chunks.join('\n\n') : undefined;
  }

  private createInteractiveSessionHooks(issueKey: string) {
    return {
      onPermissionRequest: async (request: { kind: string; [key: string]: unknown }) => {
        const task = this.activeTasks.get(issueKey);
        if (!task) {
          return {
            kind: 'denied-no-approval-rule-and-could-not-request-from-user' as const
          };
        }

        const permInfo = formatPermissionDescription(request);
        if (task.allowPermissionsForTask) {
          this.appendEvent(issueKey, evt('permission_completed', `${permInfo.description} (auto-approved for task)`));
          return { kind: 'approved' as const };
        }

        if (shouldSilentlyApprovePermissionRequest(request)) {
          this.appendEvent(
            issueKey,
            evt('permission_completed', `${permInfo.description} (silently auto-approved safe probe)`)
          );
          return { kind: 'approved' as const };
        }

        this.sessionManager.updateAgentState(issueKey, 'awaiting_approval');
        this.appendEvent(issueKey, evt('permission_requested', permInfo.description));

        return new Promise<
          | { kind: 'denied-interactively-by-user' }
          | { kind: 'approved' }
        >(resolve => {
          task.pendingPermissions.push({
            description: permInfo.description,
            kind: permInfo.kind,
            detail: permInfo.detail,
            resolve: (decision) => {
              if (decision === 'deny') {
                resolve({ kind: 'denied-interactively-by-user' as const });
              } else {
                resolve({ kind: 'approved' as const });
              }
            }
          });
        });
      },
      onUserInputRequest: async (request: {
        question: string;
        choices?: string[];
        allowFreeform?: boolean;
      }) => {
        const task = this.activeTasks.get(issueKey);
        if (!task) {
          return { answer: 'Session not found', wasFreeform: true };
        }

        const question = request.question ?? 'Input requested';
        this.sessionManager.updateAgentState(issueKey, 'awaiting_input');
        this.appendEvent(issueKey, evt('user_input_requested', question));

        return new Promise<{ answer: string; wasFreeform: boolean }>(resolve => {
          task.pendingInput = {
            resolve: (response, options) => {
              task.pendingInput = undefined;
              if (!options?.silent) {
                this.appendEvent(issueKey, evt('user_input_completed', 'User replied'));
              }
              if (!options?.silent && task.pendingPermissions.length === 0) {
                this.sessionManager.updateAgentState(issueKey, 'executing');
              }
              resolve({ answer: response, wasFreeform: true });
            }
          };
        });
      }
    };
  }

  private appendEvent(
    issueKey: string,
    event: AgentEventSummary,
    incrementSteps?: number
  ): void {
    this.sessionManager.appendAgentEvents(issueKey, [event], incrementSteps);
    this.logger.appendLine(`[Agent:${issueKey}] ${event.type}: ${event.summary}`);
  }

  private async cleanupTask(issueKey: string): Promise<void> {
    const task = this.activeTasks.get(issueKey);
    if (!task) {
      return;
    }

    // Remove from map immediately to prevent concurrent cleanup
    this.activeTasks.delete(issueKey);
    this.emitActiveTaskChange(issueKey);

    if (task.timeoutHandle) {
      clearTimeout(task.timeoutHandle);
    }
    for (const unsub of task.unsubscribes) {
      unsub();
    }

    // Resolve any pending permission/input promises so SDK handlers don't hang
    const pendingPermissions = task.pendingPermissions.splice(0);
    for (const pendingPermission of pendingPermissions) {
      pendingPermission.resolve('deny', { silent: true });
    }
    if (task.pendingInput) {
      task.pendingInput.resolve('Task ended', { silent: true });
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
