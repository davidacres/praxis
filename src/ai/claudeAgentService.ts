import * as vscode from 'vscode';
import * as nodeChildProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { IssueDetails } from '../types';
import type { AiSessionManager } from './aiSessionManager';
import type {
  AgentEventSummary,
  AgentEventType,
  AgentTaskDefinition
} from './agentTypes';
import { AGENT_DEFAULTS } from './agentTypes';
import { buildSystemPrompt, type PermissionInfo } from './copilotAgentService';

const CLAUDE_DEFAULT_MODEL = 'claude-opus-4-6';

interface ActiveTask {
  issueKey: string;
  childProcess: nodeChildProcess.ChildProcessWithoutNullStreams | null;
  sessionId: string;
  messageBuffers: Map<string, string>;
  reasoningBuffers: Map<string, string>;
  ending?: boolean;
  stopPromise?: Promise<void>;
  maxSteps: number;
  timeoutHandle?: ReturnType<typeof setTimeout>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractAssistantText(rawMessage: unknown): string | undefined {
  if (!isRecord(rawMessage)) {
    return undefined;
  }

  const content = rawMessage.content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  const chunks = content
    .map(item => {
      if (!isRecord(item) || item.type !== 'text') {
        return undefined;
      }

      return asString(item.text);
    })
    .filter((item): item is string => Boolean(item));

  if (chunks.length === 0) {
    return undefined;
  }

  return chunks.join('\n').trim() || undefined;
}

export class ClaudeAgentLogger {
  constructor(private readonly outputChannel: vscode.OutputChannel) {}

  appendLine(message: string): void {
    this.outputChannel.appendLine(`[Claude Agent] ${message}`);
  }
}

export class ClaudeAgentService {
  private readonly activeTasks = new Map<string, ActiveTask>();
  private readonly activeTaskListeners = new Set<(issueKey: string) => void>();

  constructor(
    private readonly sessionManager: AiSessionManager,
    private readonly logger: ClaudeAgentLogger
  ) {}

  public onDidChangeActiveTask(listener: (issueKey: string) => void): () => void {
    this.activeTaskListeners.add(listener);
    return () => {
      this.activeTaskListeners.delete(listener);
    };
  }

  public async startTask(
    issue: IssueDetails,
    taskDefinition: AgentTaskDefinition,
    options: { cliPath?: string; workingDirectory?: string; model?: string }
  ): Promise<string> {
    if (this.activeTasks.has(issue.key)) {
      await this.abortTask(issue.key);
    }

    const sessionId = randomUUID();
    const maxSteps = taskDefinition.maxSteps ?? AGENT_DEFAULTS.maxSteps;
    const timeoutMs = taskDefinition.timeoutMs ?? AGENT_DEFAULTS.timeoutMs;
    const task: ActiveTask = {
      issueKey: issue.key,
      childProcess: null,
      sessionId,
      messageBuffers: new Map(),
      reasoningBuffers: new Map(),
      maxSteps
    };

    this.activeTasks.set(issue.key, task);
    this.emitActiveTaskChange(issue.key);

    this.sessionManager.createAgentSession(issue.key, sessionId, taskDefinition, 'claude-cli');
    this.sessionManager.updateAgentState(issue.key, 'planning');
    this.appendEvent(issue.key, evt('session_start', 'Claude Code session started'));

    try {
      task.childProcess = this.spawnClaudeProcess(
        issue,
        taskDefinition,
        sessionId,
        options,
        false
      );
    } catch (error) {
      await this.cleanupTask(issue.key);
      throw error;
    }

    this.attachProcessHandlers(issue.key, task);
    task.timeoutHandle = setTimeout(() => {
      void this.failTaskForTimeout(issue.key, timeoutMs);
    }, timeoutMs);

    this.logger.appendLine(`Started task for ${issue.key} (session ${sessionId})`);
    return sessionId;
  }

  public async resumeTask(
    issueKey: string,
    options: { cliPath?: string; workingDirectory?: string; model?: string }
  ): Promise<void> {
    if (this.activeTasks.has(issueKey)) {
      this.logger.appendLine(`Session for ${issueKey} is already active.`);
      return;
    }

    const record = this.sessionManager.getAgentSession(issueKey);
    if (!record) {
      throw new Error(`No agent session found for ${issueKey}`);
    }

    const maxSteps = record.taskDefinition.maxSteps ?? AGENT_DEFAULTS.maxSteps;
    const timeoutMs = record.taskDefinition.timeoutMs ?? AGENT_DEFAULTS.timeoutMs;
    const task: ActiveTask = {
      issueKey,
      childProcess: null,
      sessionId: record.sessionId,
      messageBuffers: new Map(record.responseText ? [['history', record.responseText]] : []),
      reasoningBuffers: new Map(record.reasoningText ? [['history', record.reasoningText]] : []),
      maxSteps
    };

    this.activeTasks.set(issueKey, task);
    this.emitActiveTaskChange(issueKey);
    this.sessionManager.updateAgentState(issueKey, 'executing');
    this.appendEvent(issueKey, evt('session_start', 'Claude Code session resumed'));

    const issue = {
      key: record.issueKey,
      summary: record.taskDefinition.goal.split('\n')[0] || record.issueKey,
      issueType: 'Task',
      status: 'In Progress'
    } as IssueDetails;

    try {
      task.childProcess = this.spawnClaudeProcess(
        issue,
        record.taskDefinition,
        record.sessionId,
        options,
        true
      );
    } catch (error) {
      await this.cleanupTask(issueKey);
      throw error;
    }

    this.attachProcessHandlers(issueKey, task);
    task.timeoutHandle = setTimeout(() => {
      void this.failTaskForTimeout(issueKey, timeoutMs);
    }, timeoutMs);

    this.logger.appendLine(`Resumed session for ${issueKey}`);
  }

  public respondToInput(_issueKey: string, _response: string): void {
    // Claude Code runs in non-interactive print mode here.
  }

  public respondToPermission(
    _issueKey: string,
    _decision: 'allow_once' | 'allow_always' | 'deny'
  ): void {
    // Permissions are bypassed in automated Claude Code sessions.
  }

  public getPendingPermissionDescriptions(_issueKey: string): string[] {
    return [];
  }

  public getPendingPermissions(_issueKey: string): PermissionInfo[] {
    return [];
  }

  public async abortTask(issueKey: string): Promise<void> {
    await this.stopTask(issueKey, {
      terminalState: 'aborted',
      event: evt('aborted', 'Task aborted by user'),
      logLine: `Aborted task for ${issueKey}`
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
      logLine: `Paused task for ${issueKey}`
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

  private emitActiveTaskChange(issueKey: string): void {
    for (const listener of this.activeTaskListeners) {
      try {
        listener(issueKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.appendLine(`Active task listener failed for ${issueKey}: ${message}`);
      }
    }
  }

  private spawnClaudeProcess(
    issue: IssueDetails,
    taskDefinition: AgentTaskDefinition,
    sessionId: string,
    options: { cliPath?: string; workingDirectory?: string; model?: string },
    resume: boolean
  ): nodeChildProcess.ChildProcessWithoutNullStreams {
    const cliPath = options.cliPath || (process.platform === 'win32' ? 'claude.exe' : 'claude');
    const args = this.buildClaudeArgs(issue, taskDefinition, sessionId, resume, options.model);

    this.logger.appendLine(`Launching Claude Code with session ${sessionId} using ${cliPath}`);
    return nodeChildProcess.spawn(cliPath, args, {
      cwd: options.workingDirectory,
      detached: false,
      windowsHide: true
    });
  }

  private buildClaudeArgs(
    issue: IssueDetails,
    taskDefinition: AgentTaskDefinition,
    sessionId: string,
    resume: boolean,
    modelOverride?: string
  ): string[] {
    const prompt = resume
      ? `Continue working on the existing task for issue ${issue.key}.`
      : `Execute the task described in the system prompt.\n\nIssue: ${issue.key} - ${issue.summary}`;
    const resolvedModel = modelOverride || CLAUDE_DEFAULT_MODEL;
    const sessionName = `${issue.key} — ${issue.summary}`.slice(0, 120);
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', resolvedModel,
      '--name', sessionName,
      '--system-prompt', buildSystemPrompt(taskDefinition, issue),
      '--permission-mode', 'bypassPermissions',
      '--dangerously-skip-permissions'
    ];

    if (resume) {
      args.push('--resume', sessionId);
    } else {
      args.push('--session-id', sessionId);
    }

    args.push(prompt);
    return args;
  }

  private attachProcessHandlers(issueKey: string, task: ActiveTask): void {
    const childProcess = task.childProcess;
    if (!childProcess) {
      return;
    }

    let stdoutBuffer = '';
    childProcess.stdout.on('data', data => {
      stdoutBuffer += data.toString();
      stdoutBuffer = this.consumeBufferedJsonLines(issueKey, stdoutBuffer, task);
    });

    childProcess.stderr.on('data', data => {
      const message = data.toString().trim();
      if (!message) {
        return;
      }
      this.logger.appendLine(`Claude stderr: ${message}`);
      this.appendEvent(issueKey, evt('warning', `Claude stderr: ${message}`));
    });

    childProcess.on('error', error => {
      const message = error instanceof Error ? error.message : String(error);
      this.sessionManager.updateAgentState(issueKey, 'failed');
      this.appendEvent(issueKey, evt('error', `Claude process failed to start: ${message}`));
      void this.cleanupTask(issueKey);
    });

    childProcess.on('close', code => {
      const record = this.sessionManager.getAgentSession(issueKey);
      if (stdoutBuffer.trim()) {
        this.consumeBufferedJsonLines(issueKey, `${stdoutBuffer}\n`, task);
      }

      if (!record || this.isTerminalState(record.state)) {
        void this.cleanupTask(issueKey);
        return;
      }

      const message = code === 0
        ? 'Claude Code exited before returning a final result.'
        : `Claude Code exited unexpectedly with code ${code}.`;
      this.sessionManager.updateAgentState(issueKey, 'failed');
      this.appendEvent(issueKey, evt('error', message));
      void this.cleanupTask(issueKey);
    });
  }

  private consumeBufferedJsonLines(issueKey: string, buffer: string, task: ActiveTask): string {
    const lines = buffer.split(/\r?\n/);
    const remainder = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const event = JSON.parse(trimmed) as { type?: string; [key: string]: unknown };
        this.handleSessionEvent(issueKey, event, task);
      } catch {
        this.logger.appendLine(`Failed to parse Claude output: ${trimmed.slice(0, 200)}`);
      }
    }

    return remainder;
  }

  private isTerminalState(state: string | undefined): boolean {
    return state === 'completed' || state === 'failed' || state === 'aborted';
  }

  private handleSessionEvent(
    issueKey: string,
    event: { type?: string; [key: string]: unknown },
    task: ActiveTask
  ): void {
    const record = this.sessionManager.getAgentSession(issueKey);
    if (task.ending || (record && this.isTerminalState(record.state))) {
      return;
    }

    switch (event.type) {
      case 'assistant': {
        const message = event.message;
        const content = extractAssistantText(message);
        const messageId = isRecord(message)
          ? asString(message.id) ?? `message-${task.messageBuffers.size + 1}`
          : `message-${task.messageBuffers.size + 1}`;

        if (content) {
          task.messageBuffers.set(messageId, content);
          this.syncLiveOutput(issueKey, task, { persist: false });

          const preview = content.length > 200 ? `${content.slice(0, 200)}…` : content;
          this.appendEvent(issueKey, evt('message', preview, content));

          if (record?.state === 'planning') {
            this.sessionManager.setAgentPlan(issueKey, content);
            this.sessionManager.updateAgentState(issueKey, 'executing');
          }
        }

        const error = asString(event.error);
        if (error) {
          this.appendEvent(issueKey, evt('error', `Claude error: ${error}`));
        }
        break;
      }

      case 'result': {
        const resultText = asString(event.result) ?? this.joinStreamingBuffers(task.messageBuffers) ?? '';
        const isError = event.is_error === true;
        this.sessionManager.updateAgentOutput(
          issueKey,
          {
            responseText: resultText || undefined,
            reasoningText: this.joinStreamingBuffers(task.reasoningBuffers)
          },
          { persist: false }
        );

        if (isError) {
          this.sessionManager.updateAgentState(issueKey, 'failed');
          this.appendEvent(issueKey, evt('error', `Task failed: ${resultText || 'Claude Code returned an error.'}`));
        } else {
          this.sessionManager.updateAgentState(issueKey, 'completed');
          this.appendEvent(issueKey, evt('task_complete', 'Task complete'));
        }
        void this.cleanupTask(issueKey);
        break;
      }

      case 'system': {
        const subtype = asString(event.subtype);
        if (subtype === 'init') {
          const model = asString(event.model);
          if (model) {
            this.appendEvent(issueKey, evt('info', `Claude Code initialised with model ${model}.`));
          }
          break;
        }

        if (subtype === 'hook_response' && event.exit_code !== 0) {
          const hookName = asString(event.hook_name) ?? 'hook';
          const stderr = asString(event.stderr);
          this.appendEvent(issueKey, evt('warning', `${hookName} exited non-zero.`, stderr));
        }
        break;
      }

      default:
        break;
    }
  }

  private syncLiveOutput(
    issueKey: string,
    task: ActiveTask,
    options?: { persist?: boolean }
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
    return chunks.length > 0 ? chunks.join('\n\n') : undefined;
  }

  private appendEvent(
    issueKey: string,
    event: AgentEventSummary,
    incrementSteps?: number
  ): void {
    this.sessionManager.appendAgentEvents(issueKey, [event], incrementSteps);
    this.logger.appendLine(`[ClaudeAgent:${issueKey}] ${event.type}: ${event.summary}`);
  }

  private async failTaskForTimeout(issueKey: string, timeoutMs: number): Promise<void> {
    await this.stopTask(issueKey, {
      terminalState: 'failed',
      event: evt(
        'error',
        `Task stopped after timing out at ${Math.round(timeoutMs / 1000)}s. Start a new session to continue.`
      ),
      logLine: `Timeout reached for ${issueKey} (${timeoutMs}ms)`
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

      await this.cleanupTask(issueKey);
      this.logger.appendLine(options.logLine);
    })();

    await task.stopPromise;
  }

  private async cleanupTask(issueKey: string): Promise<void> {
    const task = this.activeTasks.get(issueKey);
    if (!task) {
      return;
    }

    this.activeTasks.delete(issueKey);
    this.emitActiveTaskChange(issueKey);

    if (task.timeoutHandle) {
      clearTimeout(task.timeoutHandle);
    }

    if (task.childProcess) {
      try {
        task.childProcess.kill();
      } catch {
        // Best-effort cleanup.
      }
      task.childProcess = null;
    }
  }
}
