import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import type { IssueDetails } from '../types';
import { runAgentLoop, type AgentLoopEvent, type WireMessage } from './agentRuntime';
import { buildSystemPrompt, type PermissionInfo } from './agentPrompt';
import { AGENT_DEFAULTS, type AgentEventSummary, type AgentEventType, type AgentTaskDefinition } from './agentTypes';
import type { AiSessionManager } from './aiSessionManager';
import {
  resolveGatewayApiKeyFromEnv,
  resolveGatewayUrlFromEnv,
  toWireModelId,
  type GatewayOptions
} from './gateway';
import { LOCAL_TOOL_DEFINITIONS, LocalToolExecutor, type PermissionDecision } from './tools';
import { shouldAutoAllowToolPermission } from './tools/shellAllowlist';

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';

interface ActiveTask {
  issueKey: string;
  abortController: AbortController;
  pendingPermissions: Array<{
    description: string;
    kind: string;
    detail?: string;
    resolve: (result: PermissionDecision) => void;
  }>;
  allowPermissionsForTask: boolean;
  pendingInput?: {
    resolve: (response: string) => void;
  };
  messageBuffer: string;
  loopPromise?: Promise<void>;
  ending?: boolean;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  maxSteps: number;
}

function now(): string {
  return new Date().toISOString();
}

function evt(type: AgentEventType, summary: string, detail?: string): AgentEventSummary {
  return { timestamp: now(), type, summary, detail };
}

export interface VercelAgentLogger {
  appendLine(message: string): void;
}

export interface VercelAgentStartOptions {
  apiKey?: string;
  gatewayUrl?: string;
  workingDirectory?: string;
  model?: string;
}

export class VercelAgentService {
  private readonly activeTasks = new Map<string, ActiveTask>();
  private readonly activeTaskListeners = new Set<(issueKey: string) => void>();

  constructor(
    private readonly sessionManager: AiSessionManager,
    private readonly logger: VercelAgentLogger
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
        this.logger.appendLine(`[VercelAgent] Active task listener failed for ${issueKey}: ${message}`);
      }
    }
  }

  private isTerminalState(state: string | undefined): boolean {
    return state === 'completed' || state === 'failed' || state === 'aborted';
  }

  private appendEvent(issueKey: string, event: AgentEventSummary, incrementSteps?: number): void {
    this.sessionManager.appendAgentEvents(issueKey, [event], incrementSteps);
  }

  private resolveGateway(options: VercelAgentStartOptions): GatewayOptions {
    const apiKey = resolveGatewayApiKeyFromEnv(options.apiKey);
    const url = resolveGatewayUrlFromEnv(options.gatewayUrl);
    if (!apiKey) {
      throw new Error('Vercel AI Gateway API key is not configured.');
    }
    return { url, apiKey };
  }

  private loadWorkflowInstructionsForPrompt(
    instructionsPath: string,
    workingDirectory: string | undefined
  ): { absolutePath: string; realPath?: string; content?: string; error?: string } {
    let absolutePath = instructionsPath;
    if (!nodePath.isAbsolute(absolutePath) && workingDirectory) {
      absolutePath = nodePath.resolve(workingDirectory, absolutePath);
    }
    let realPath: string | undefined;
    let readPath = absolutePath;
    try {
      realPath = nodeFs.realpathSync(absolutePath);
      readPath = realPath;
    } catch {
      // best-effort
    }
    try {
      const content = nodeFs.readFileSync(readPath, 'utf8');
      return { absolutePath, realPath, content };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { absolutePath, realPath, error: message };
    }
  }

  private buildInitialPrompt(
    issue: IssueDetails,
    taskDefinition: AgentTaskDefinition,
    workingDirectory: string | undefined
  ): string {
    const workflow = taskDefinition.workflow
      ? (() => {
          const loaded = this.loadWorkflowInstructionsForPrompt(
            taskDefinition.workflow.instructionsPath,
            workingDirectory
          );
          const header = [
            '',
            '## CRITICAL WORKFLOW DIRECTIVE',
            `You have been assigned the **${taskDefinition.workflow.name}** workflow pack.`,
            taskDefinition.workflow.link ? `Reference link: ${taskDefinition.workflow.link}` : undefined,
            '',
            'It is CRITICAL that you follow this workflow PRECISELY. Use the instructions below as the authoritative playbook for every step. Do not improvise an alternative approach. Do not deviate from the workflow ordering, sub-agent choices, or review gates.'
          ].filter((line): line is string => line !== undefined);
          if (loaded.content) {
            return [
              ...header,
              '',
              `Source: ${loaded.realPath ?? loaded.absolutePath}`,
              '',
              '----- BEGIN WORKFLOW INSTRUCTIONS -----',
              loaded.content.trimEnd(),
              '----- END WORKFLOW INSTRUCTIONS -----'
            ].join('\n');
          }
          return [
            ...header,
            '',
            `Instructions file (failed to inline, please read manually): ${loaded.realPath ?? loaded.absolutePath}`,
            loaded.error ? `Read error: ${loaded.error}` : undefined
          ]
            .filter((line): line is string => line !== undefined)
            .join('\n');
        })()
      : '';
    const worktreeLine = workingDirectory
      ? `\nWorktree (run ALL git and build commands from here): ${workingDirectory}`
      : '';
    return `Execute the task described in the system prompt.

Issue: ${issue.key} — ${issue.summary}${worktreeLine}${workflow}`;
  }

  private requestPermission(
    issueKey: string,
    request: {
      kind: string;
      description: string;
      detail?: string;
    }
  ): Promise<PermissionDecision> {
    const task = this.activeTasks.get(issueKey);
    if (!task) {
      return Promise.resolve('deny');
    }
    if (task.allowPermissionsForTask) {
      return Promise.resolve('allow_always');
    }

    return new Promise<PermissionDecision>(resolve => {
      task.pendingPermissions.push({
        description: request.description,
        kind: request.kind,
        detail: request.detail,
        resolve
      });
      this.sessionManager.updateAgentState(issueKey, 'awaiting_approval');
      this.appendEvent(
        issueKey,
        evt('permission_requested', request.description, request.detail)
      );
    });
  }

  private handleLoopEvent(issueKey: string, event: AgentLoopEvent, task: ActiveTask): void {
    switch (event.type) {
      case 'text_delta':
        task.messageBuffer += event.text;
        this.sessionManager.updateAgentOutput(
          issueKey,
          { responseText: task.messageBuffer },
          { persist: false }
        );
        if (this.sessionManager.getAgentSession(issueKey)?.state === 'planning' && task.messageBuffer) {
          this.sessionManager.setAgentPlan(issueKey, task.messageBuffer, { persist: false });
        }
        break;
      case 'message': {
        task.messageBuffer = event.text || task.messageBuffer;
        this.sessionManager.updateAgentOutput(issueKey, { responseText: task.messageBuffer });
        const preview =
          task.messageBuffer.length > 200
            ? `${task.messageBuffer.slice(0, 200)}…`
            : task.messageBuffer || 'Assistant produced an empty message';
        this.appendEvent(issueKey, evt('message', preview, task.messageBuffer || undefined));
        const record = this.sessionManager.getAgentSession(issueKey);
        if (record?.state === 'planning' && task.messageBuffer) {
          this.sessionManager.setAgentPlan(issueKey, task.messageBuffer);
          this.sessionManager.updateAgentState(issueKey, 'executing');
        }
        break;
      }
      case 'tool_start':
        this.appendEvent(issueKey, evt('tool_start', `Running tool: ${event.name}`));
        break;
      case 'tool_complete':
        this.appendEvent(
          issueKey,
          evt(
            'tool_complete',
            `Tool ${event.ok ? 'completed' : 'failed'}: ${event.name}`,
            event.content.slice(0, 2000)
          ),
          1
        );
        break;
      case 'step':
        break;
      case 'completed':
        this.appendEvent(issueKey, evt('task_complete', 'Agent completed the task'));
        break;
      case 'error':
        this.appendEvent(issueKey, evt('error', event.message));
        break;
      default:
        break;
    }
  }

  private async runLoopForIssue(
    issueKey: string,
    options: {
      systemPrompt: string;
      userPrompt?: string;
      history?: WireMessage[];
      gateway: GatewayOptions;
      model: string;
      workingDirectory: string;
      maxSteps: number;
      timeoutMs: number;
    }
  ): Promise<void> {
    const task = this.activeTasks.get(issueKey);
    if (!task) {
      return;
    }

    const toolExecutor = new LocalToolExecutor({
      workingDirectory: options.workingDirectory,
      shouldAutoAllow: shouldAutoAllowToolPermission,
      requestPermission: async request => this.requestPermission(issueKey, request)
    });

    const result = await runAgentLoop({
      gateway: options.gateway,
      modelId: toWireModelId(options.model),
      systemPrompt: options.systemPrompt,
      tools: LOCAL_TOOL_DEFINITIONS,
      toolExecutor,
      history: options.history,
      userPrompt: options.userPrompt,
      maxSteps: options.maxSteps,
      timeoutMs: options.timeoutMs,
      signal: task.abortController.signal,
      onEvent: event => {
        const active = this.activeTasks.get(issueKey);
        if (!active || active.ending) {
          return;
        }
        this.handleLoopEvent(issueKey, event, active);
      }
    });

    const active = this.activeTasks.get(issueKey);
    if (!active || active.ending) {
      return;
    }

    this.sessionManager.setAgentConversationHistory(issueKey, result.history);
    this.sessionManager.updateAgentOutput(issueKey, {
      responseText: result.text || active.messageBuffer
    });

    if (result.status === 'completed') {
      this.sessionManager.updateAgentState(issueKey, 'completed');
      this.appendEvent(issueKey, evt('idle', 'Agent session idle after completion'));
    } else if (result.status === 'aborted') {
      // abortTask already sets state
    } else if (result.status === 'step_limit') {
      active.maxSteps = Number.MAX_SAFE_INTEGER;
      this.appendEvent(issueKey, evt('info', 'Step limit removed automatically (autopilot mode).'));
      // Continue from history with raised step limit
      await this.runLoopForIssue(issueKey, {
        ...options,
        history: result.history,
        userPrompt: undefined,
        maxSteps: active.maxSteps
      });
      return;
    } else {
      this.sessionManager.updateAgentState(issueKey, 'failed');
      if (result.error) {
        this.appendEvent(issueKey, evt('error', result.error));
      }
    }

    await this.cleanupTask(issueKey);
  }

  public async startTask(
    issue: IssueDetails,
    taskDefinition: AgentTaskDefinition,
    options: VercelAgentStartOptions
  ): Promise<string> {
    if (this.activeTasks.has(issue.key)) {
      await this.abortTask(issue.key);
    }

    const gateway = this.resolveGateway(options);
    const workingDirectory = options.workingDirectory?.trim() || process.cwd();
    const maxSteps = taskDefinition.maxSteps ?? AGENT_DEFAULTS.maxSteps;
    const timeoutMs = taskDefinition.timeoutMs ?? AGENT_DEFAULTS.timeoutMs;
    const model = options.model?.trim() || DEFAULT_MODEL;
    const sessionId = randomUUID();
    const systemPrompt = buildSystemPrompt(taskDefinition, issue);
    const userPrompt = this.buildInitialPrompt(issue, taskDefinition, workingDirectory);

    const task: ActiveTask = {
      issueKey: issue.key,
      abortController: new AbortController(),
      pendingPermissions: [],
      allowPermissionsForTask: false,
      messageBuffer: '',
      maxSteps
    };
    this.activeTasks.set(issue.key, task);
    this.emitActiveTaskChange(issue.key);

    this.sessionManager.createAgentSession(issue.key, sessionId, taskDefinition, 'vercel-gateway');
    this.sessionManager.updateAgentState(issue.key, 'planning');
    this.appendEvent(issue.key, evt('session_start', 'Vercel gateway agent session started'));

    task.timeoutHandle = setTimeout(() => {
      void this.failTaskForTimeout(issue.key, timeoutMs);
    }, timeoutMs);

    this.logger.appendLine(
      `[VercelAgent] Starting session for ${issue.key} model=${model} cwd=${workingDirectory}`
    );

    task.loopPromise = this.runLoopForIssue(issue.key, {
      systemPrompt,
      userPrompt,
      gateway,
      model,
      workingDirectory,
      maxSteps,
      timeoutMs
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.appendLine(`[VercelAgent] Session failed for ${issue.key}: ${message}`);
      const record = this.sessionManager.getAgentSession(issue.key);
      if (record && !this.isTerminalState(record.state)) {
        this.sessionManager.updateAgentState(issue.key, 'failed');
        this.appendEvent(issue.key, evt('error', message));
      }
    }).finally(() => {
      void this.cleanupTask(issue.key);
    });

    return sessionId;
  }

  public async resumeTask(issueKey: string, options: VercelAgentStartOptions): Promise<void> {
    if (this.activeTasks.has(issueKey)) {
      return;
    }
    const record = this.sessionManager.getAgentSession(issueKey);
    if (!record) {
      throw new Error(`No agent session found for ${issueKey}`);
    }

    const gateway = this.resolveGateway(options);
    const workingDirectory = options.workingDirectory?.trim() || process.cwd();
    const maxSteps = record.taskDefinition.maxSteps ?? AGENT_DEFAULTS.maxSteps;
    const timeoutMs = record.taskDefinition.timeoutMs ?? AGENT_DEFAULTS.timeoutMs;
    const model = options.model?.trim() || DEFAULT_MODEL;
    const history = this.sessionManager.getAgentConversationHistory(issueKey);
    const systemPrompt = buildSystemPrompt(record.taskDefinition, {
      key: issueKey,
      summary: record.taskDefinition.goal,
      issueType: 'Task',
      status: 'Unknown',
      description: record.taskDefinition.scope
    } as IssueDetails);

    const task: ActiveTask = {
      issueKey,
      abortController: new AbortController(),
      pendingPermissions: [],
      allowPermissionsForTask: false,
      messageBuffer: record.responseText ?? '',
      maxSteps
    };
    this.activeTasks.set(issueKey, task);
    this.emitActiveTaskChange(issueKey);

    this.sessionManager.updateAgentState(issueKey, 'executing');
    this.appendEvent(issueKey, evt('session_start', 'Session resumed'));
    this.logger.appendLine(`[VercelAgent] Resumed session for ${issueKey}`);

    task.timeoutHandle = setTimeout(() => {
      void this.failTaskForTimeout(issueKey, timeoutMs);
    }, timeoutMs);

    const resumePrompt =
      history.length === 0
        ? 'Continue the task from where you left off.'
        : 'Continue the task. Use tools as needed and stop when the Definition of Done is met.';

    task.loopPromise = this.runLoopForIssue(issueKey, {
      systemPrompt,
      userPrompt: resumePrompt,
      history,
      gateway,
      model,
      workingDirectory,
      maxSteps,
      timeoutMs
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.appendLine(`[VercelAgent] Resume failed for ${issueKey}: ${message}`);
      const current = this.sessionManager.getAgentSession(issueKey);
      if (current && !this.isTerminalState(current.state)) {
        this.sessionManager.updateAgentState(issueKey, 'failed');
        this.appendEvent(issueKey, evt('error', message));
      }
    }).finally(() => {
      void this.cleanupTask(issueKey);
    });
  }

  public respondToInput(issueKey: string, response: string): void {
    const task = this.activeTasks.get(issueKey);
    if (!task?.pendingInput) {
      return;
    }
    task.pendingInput.resolve(response);
    task.pendingInput = undefined;
    this.appendEvent(issueKey, evt('user_input_completed', 'User input provided'));
    this.sessionManager.updateAgentState(issueKey, 'executing');
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
      return;
    }
    if (!task.pendingInput) {
      this.sessionManager.updateAgentState(issueKey, 'executing');
    }
  }

  public getPendingPermissionDescriptions(issueKey: string): string[] {
    return this.getPendingPermissions(issueKey).map(p => p.description);
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

  public async abortTask(issueKey: string): Promise<void> {
    await this.stopTask(issueKey, {
      terminalState: 'aborted',
      event: evt('aborted', 'Task aborted by user'),
      logLine: `[VercelAgent] Aborted task for ${issueKey}`
    });
  }

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
      logLine: `[VercelAgent] Paused task for ${issueKey}`
    });
  }

  public async pauseAllTasks(reason?: string): Promise<void> {
    const issueKeys = [...this.activeTasks.keys()];
    for (const key of issueKeys) {
      await this.pauseTask(key, reason ?? 'Session paused.');
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
      logLine: `[VercelAgent] Timeout reached for ${issueKey} (${timeoutMs}ms)`
    });
  }

  private async stopTask(
    issueKey: string,
    options: {
      terminalState: 'aborted' | 'failed' | 'paused';
      event: AgentEventSummary;
      logLine: string;
    }
  ): Promise<void> {
    const task = this.activeTasks.get(issueKey);
    if (!task) {
      return;
    }
    if (task.ending) {
      await task.loopPromise;
      return;
    }
    task.ending = true;
    for (const pending of task.pendingPermissions.splice(0)) {
      pending.resolve('deny');
    }
    task.abortController.abort();

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
    if (task.timeoutHandle) {
      clearTimeout(task.timeoutHandle);
    }
    this.activeTasks.delete(issueKey);
    this.emitActiveTaskChange(issueKey);
  }
}
