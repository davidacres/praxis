import { spawn, type ChildProcess } from 'node:child_process';
import * as nodeFs from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
// Type-only import: `@agentclientprotocol/sdk` ships ESM-only, and this
// package compiles to CommonJS — a value import would emit a `require()`
// call Node can't satisfy for a pure-ESM dependency. Type-only imports are
// erased, so they're safe; the runtime module is loaded via dynamic
// `import()` in `connect()` instead (Node's supported CJS→ESM interop path).
import type * as acp from '@agentclientprotocol/sdk' with { 'resolution-mode': 'import' };
import type { LogSink } from '../../host/logSink';
import { resolveSandboxedPath } from '../tools/pathSandbox';
import type { PermissionDecision } from '../tools';
import type { AgentToolMode } from '../agentTypes';
import type { WireImageAttachment } from '../gateway/wire';
import type { ProviderCapabilityManifest } from '../providers/providerPreflight';

/**
 * Thin host-side wrapper around `@agentclientprotocol/sdk`'s `ClientApp` —
 * spawns an ACP-compatible agent CLI (Claude Code, Codex) as a subprocess and
 * drives one session over stdio JSON-RPC.
 *
 * File I/O (`fs/read_text_file`/`fs/write_text_file`) is handled here,
 * sandboxed to `workingDirectory` via the same `resolveSandboxedPath` the
 * local-tools loop uses (`tools/pathSandbox.ts`) — consistent sandboxing
 * across both agent-hosting paths.
 *
 * Terminal support is deliberately NOT advertised (`clientCapabilities.terminal`
 * omitted): ACP agents fall back to their own command execution when the
 * client doesn't support it, so this stays a real, spec-compliant choice
 * rather than a stub — implementing the terminal/* protocol is a larger,
 * separately-scoped piece of work.
 */

export interface AcpPermissionRequest {
  toolCallId: string;
  title: string;
  /** Optional provider tool name; useful when `title` is only an opaque ID. */
  name?: string;
  kind?: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export interface CursorAskQuestionRequest {
  toolCallId: string;
  title?: string;
  questions: Array<{
    id: string;
    prompt: string;
    options: Array<{ id: string; label: string }>;
    allowMultiple?: boolean;
  }>;
}

export interface CursorAskQuestionResponse {
  outcome:
    | {
        outcome: 'answered';
        answers: Array<{
          questionId: string;
          selectedOptionIds: string[];
        }>;
      }
    | { outcome: 'skipped'; reason?: string }
    | { outcome: 'cancelled' };
}

export interface CursorCreatePlanRequest {
  toolCallId: string;
  name?: string;
  overview?: string;
  plan: string;
  todos: Array<{
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  }>;
  isProject?: boolean;
  phases?: Array<{
    name: string;
    todos: Array<{
      id: string;
      content: string;
      status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    }>;
  }>;
}

export interface CursorCreatePlanResponse {
  outcome:
    | { outcome: 'accepted'; planUri?: string }
    | { outcome: 'rejected'; reason?: string }
    | { outcome: 'cancelled' };
}

export interface CursorUpdateTodosNotification {
  toolCallId: string;
  todos: Array<{
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  }>;
  merge: boolean;
}

export interface CursorTaskNotification {
  toolCallId: string;
  description: string;
  prompt: string;
  subagentType?: unknown;
  model?: string;
  agentId?: string;
  durationMs?: number;
}

export interface CursorGenerateImageNotification {
  toolCallId: string;
  description: string;
  filePath?: string;
  referenceImagePaths?: string[];
}

export interface AcpClientOptions {
  /** Executable to spawn (e.g. `claude-agent-acp`, `codex-acp`, `agent`), resolved on PATH or an absolute path. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Explicit authentication method ID (e.g. `cursor_login`). Defaults to first non-terminal method advertised by the agent. */
  authMethod?: string;
  /** Session cwd and the fs sandbox root for `fs/read_text_file`/`fs/write_text_file`. */
  workingDirectory: string;
  toolMode?: AgentToolMode;
  /** Provider-owned ACP session to resume when supported by the agent. */
  resumeSessionId?: string;
  /**
   * HTTP MCP servers to hand the agent in `session/new` (and `session/load`).
   * Ignored unless the agent's `initialize` response advertises
   * `mcpCapabilities.http`.
   */
  mcpServers?: Array<
    | { name: string; url: string; headers?: Record<string, string> }
    | { name: string; command: string; args?: string[]; env?: Record<string, string> }
  >;
  requestPermission: (request: AcpPermissionRequest) => Promise<PermissionDecision>;
  onSessionUpdate: (update: acp.SessionUpdate) => void;
  onCursorAskQuestion?: (request: CursorAskQuestionRequest) => Promise<CursorAskQuestionResponse>;
  onCursorCreatePlan?: (request: CursorCreatePlanRequest) => Promise<CursorCreatePlanResponse>;
  onCursorUpdateTodos?: (notification: CursorUpdateTodosNotification) => void;
  onCursorTask?: (notification: CursorTaskNotification) => void;
  onCursorGenerateImage?: (notification: CursorGenerateImageNotification) => void;
  logSink?: LogSink;
}

/** Maps our 3-way local permission decision onto whichever ACP option the agent actually offered. */
export function pickPermissionOptionId(
  decision: PermissionDecision,
  options: ReadonlyArray<{ optionId: string; kind: string }>
): string | undefined {
  const preferredKinds: acp.PermissionOptionKind[] =
    decision === 'allow_once'
      ? ['allow_once', 'allow_always']
      : decision === 'allow_always'
        ? ['allow_always', 'allow_once']
        : ['reject_once', 'reject_always'];
  for (const kind of preferredKinds) {
    const match = options.find(
      o => o.kind === kind || o.optionId === kind || o.optionId === kind.replace('_', '-')
    );
    if (match) {
      return match.optionId;
    }
  }
  return options[0]?.optionId;
}

/**
 * An agent's JSON-RPC error names only its code ("Internal error", -32603); the reason a
 * person can act on is in `data.message` — Codex puts "You've hit your usage limit… try
 * again at …" there. Promote it to the error's message so every caller (a session, a
 * workflow stage, a one-shot recommendation) shows the real reason, and so provider-limit
 * detection can read it. `code` and `data` are left as they were.
 */
export function withAgentErrorDetail(error: unknown): unknown {
  if (!error || typeof error !== 'object') return error;
  const candidate = error as { message?: unknown; data?: unknown };
  const data = candidate.data;
  const detail =
    data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string'
      ? ((data as { message: string }).message).trim()
      : '';
  if (!detail) return error;
  const current = typeof candidate.message === 'string' ? candidate.message : '';
  if (current.includes(detail)) return error;
  try {
    (error as { message: string }).message = detail;
  } catch {
    return Object.assign(new Error(detail), { cause: error, data, code: (error as { code?: unknown }).code });
  }
  return error;
}

export class AcpClientWrapper {
  private child?: ChildProcess;
  private connection?: acp.ClientConnection;
  private session?: acp.ActiveSession;
  private acpModule?: typeof acp;
  private initializeResponse?: acp.InitializeResponse;
  private resumedSessionId?: string;
  private resumedConfigOptions?: acp.SessionConfigOption[];
  private resumeAttempted = false;
  /**
   * A resumed provider may replay historical session updates while restoring
   * its state. Those are context, not output from the new user turn, so only
   * forward notifications while `session/prompt` itself is in flight.
   */
  private promptInFlight = false;
  private lastReplayNotificationAt = 0;
  private disposed = false;
  private shuttingDown = false;
  constructor(private readonly options: AcpClientOptions) {}

  /** Spawns the agent subprocess and completes the ACP `initialize` handshake. */
  public async connect(): Promise<void> {
    try {
      await this.connectInner();
    } catch (error) {
      throw withAgentErrorDetail(error);
    }
  }

  private async connectInner(): Promise<void> {
    const acpModule: typeof acp = await import('@agentclientprotocol/sdk');
    this.acpModule = acpModule;

    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.workingDirectory,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;

    child.stderr?.on('data', chunk => {
      this.options.logSink?.appendLine(`[acp:stderr] ${chunk.toString('utf8').trimEnd()}`);
    });
    const logStreamError = (streamName: string) => (err: Error) => {
      if (this.disposed || this.shuttingDown) {
        return;
      }
      // A client can close the ACP transport while the agent is still flushing
      // output. Node reports that race as EPIPE on the child stdio stream; it
      // must be observed or it becomes an uncaught 'error' event.
      if (err.message.includes('EPIPE') || (err as NodeJS.ErrnoException).code === 'EPIPE') {
        this.options.logSink?.appendLine(`[acp] ${streamName} closed while stopping the agent`);
        return;
      }
      this.options.logSink?.appendLine(`[acp] ${streamName} stream error: ${err.message}`);
    };
    child.stdin?.on('error', logStreamError('stdin'));
    child.stdout?.on('error', logStreamError('stdout'));
    child.stderr?.on('error', logStreamError('stderr'));
    child.on('error', err => {
      if (this.disposed || this.shuttingDown) {
        return;
      }
      this.options.logSink?.appendLine(`[acp] subprocess error: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
      if (this.disposed || this.shuttingDown) {
        return;
      }
      // Diagnostics only: killing the child closes the ACP transport, and the
      // SDK already rejects the in-flight turn from that. Verified — a test that
      // kills the agent mid-turn passes with or without any extra signal here.
      const how = signal ? `signal ${signal}` : `code ${code}`;
      const qualifier = code === 0 && !signal ? '' : ' unexpectedly';
      this.options.logSink?.appendLine(`[acp] agent exited${qualifier} (${how})`);
    });

    if (!child.stdin || !child.stdout) {
      throw new Error(`Failed to spawn ACP agent '${this.options.command}': no stdio pipes.`);
    }
    const stream = acpModule.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    );

    const app = acpModule.client({ name: 'praxis' });

    app.onRequest(acpModule.CLIENT_METHODS.session_request_permission, async ctx => {
      const { toolCall, options } = ctx.params;
      const decision = await this.options.requestPermission({
        toolCallId: toolCall.toolCallId,
        title: toolCall.title ?? toolCall.toolCallId,
        name: toolCall.name ?? undefined,
        kind: toolCall.kind ?? undefined,
        options: options.map(o => ({ optionId: o.optionId, name: o.name, kind: o.kind }))
      });
      const optionId = pickPermissionOptionId(decision, options);
      if (!optionId) {
        return { outcome: { outcome: 'cancelled' } };
      }
      return { outcome: { outcome: 'selected', optionId } };
    });

    app.onRequest(acpModule.CLIENT_METHODS.fs_read_text_file, async ctx => {
      if (this.options.toolMode === 'project-only') {
        throw new Error('File reads are unavailable without a project workspace folder.');
      }
      const path = resolveSandboxedPath(this.options.workingDirectory, ctx.params.path);
      let content = await nodeFs.readFile(path, 'utf8');
      const { line, limit } = ctx.params;
      if (typeof line === 'number' || typeof limit === 'number') {
        const lines = content.split('\n');
        const start = typeof line === 'number' ? Math.max(0, line - 1) : 0;
        const end = typeof limit === 'number' ? start + limit : lines.length;
        content = lines.slice(start, end).join('\n');
      }
      return { content };
    });

    app.onRequest(acpModule.CLIENT_METHODS.fs_write_text_file, async ctx => {
      if (this.options.toolMode === 'read-only' || this.options.toolMode === 'project-only') {
        throw new Error('File writes are unavailable in read-only tool mode.');
      }
      const path = resolveSandboxedPath(this.options.workingDirectory, ctx.params.path);
      await nodeFs.writeFile(path, ctx.params.content, 'utf8');
    });

    app.onNotification(acpModule.CLIENT_METHODS.session_update, ctx => {
      if (!this.resumedSessionId || ctx.params.sessionId !== this.resumedSessionId) {
        return;
      }
      if (this.promptInFlight) {
        this.options.onSessionUpdate(ctx.params.update);
      } else {
        // Replay traffic from session/resume or session/load arriving before
        // the prompt gate opens. Track it so `waitForReplayToQuiet` can wait
        // out a slow or bursty flush instead of trusting one fixed delay.
        this.lastReplayNotificationAt = Date.now();
      }
    });

    app.onRequest('cursor/ask_question', (p: unknown) => p as CursorAskQuestionRequest, async ctx => {
      if (this.options.onCursorAskQuestion) {
        return this.options.onCursorAskQuestion(ctx.params);
      }
      return { outcome: { outcome: 'skipped', reason: 'Unattended turn' } };
    });

    app.onRequest('cursor/create_plan', (p: unknown) => p as CursorCreatePlanRequest, async ctx => {
      if (this.options.onCursorCreatePlan) {
        return this.options.onCursorCreatePlan(ctx.params);
      }
      return { outcome: { outcome: 'accepted' } };
    });

    app.onNotification('cursor/update_todos', (p: unknown) => p as CursorUpdateTodosNotification, ctx => {
      this.options.onCursorUpdateTodos?.(ctx.params);
    });

    app.onNotification('cursor/task', (p: unknown) => p as CursorTaskNotification, ctx => {
      this.options.onCursorTask?.(ctx.params);
    });

    app.onNotification('cursor/generate_image', (p: unknown) => p as CursorGenerateImageNotification, ctx => {
      this.options.onCursorGenerateImage?.(ctx.params);
    });

    this.connection = app.connect(stream);

    this.initializeResponse = await this.connection.agent.request(acpModule.AGENT_METHODS.initialize, {
      protocolVersion: acpModule.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: this.options.toolMode !== 'project-only',
          writeTextFile: this.options.toolMode === 'full'
        }
      },
      clientInfo: { name: 'praxis', version: '0.0.0' }
    });

    const authMethod =
      this.options.authMethod ||
      this.initializeResponse.authMethods?.find(m => !('type' in m) || (m as { type?: string }).type !== 'terminal')?.id;
    if (authMethod) {
      try {
        await this.connection.agent.request(acpModule.AGENT_METHODS.authenticate, {
          methodId: authMethod
        });
      } catch (err) {
        this.options.logSink?.appendLine(
          `[acp] authentication with ${authMethod} failed: ${err instanceof Error ? err.message : String(err)}`
        );
        throw err;
      }
    }
  }

  /** Provider-owned session id, available after session creation or successful native resume. */
  public get sessionId(): string | undefined {
    return this.resumedSessionId ?? this.session?.sessionId;
  }

  /** Stable, persisted representation of the ACP features negotiated at initialize time. */
  public getCapabilityManifest(): ProviderCapabilityManifest | undefined {
    const capabilities = this.initializeResponse?.agentCapabilities;
    if (!capabilities) return undefined;
    return {
      protocol: 'acp',
      sessionResume: Boolean(capabilities.sessionCapabilities?.resume),
      sessionLoad: capabilities.loadSession === true,
      sessionClose: Boolean(capabilities.sessionCapabilities?.close),
      mcpHttp: capabilities.mcpCapabilities?.http === true
    };
  }

  private async tryResumeSession(): Promise<boolean> {
    if (this.resumeAttempted) return Boolean(this.resumedSessionId);
    this.resumeAttempted = true;
    const sessionId = this.options.resumeSessionId?.trim();
    if (!sessionId || !this.connection || !this.acpModule || !this.initializeResponse) return false;
    const capabilities = this.initializeResponse.agentCapabilities;
    if (!capabilities) return false;
    // `session/resume` carries no `mcpServers` field, so a native resume would
    // drop the in-app browser on every follow-up turn. When we have MCP servers
    // to (re)attach, prefer `session/load`, which takes them.
    const mcpServers = this.mcpServersForSession();
    const useLoad = capabilities.loadSession && (mcpServers.length > 0 || !capabilities.sessionCapabilities?.resume);
    try {
      if (useLoad) {
        const response = await this.connection.agent.request(this.acpModule.AGENT_METHODS.session_load, {
          sessionId,
          cwd: this.options.workingDirectory,
          mcpServers,
          additionalDirectories: []
        });
        this.resumedConfigOptions = response.configOptions ?? undefined;
      } else if (capabilities.sessionCapabilities?.resume) {
        const response = await this.connection.agent.request(this.acpModule.AGENT_METHODS.session_resume, {
          sessionId,
          cwd: this.options.workingDirectory,
          additionalDirectories: []
        });
        this.resumedConfigOptions = response.configOptions ?? undefined;
      } else {
        return false;
      }
      this.resumedSessionId = sessionId;
      return true;
    } catch (error) {
      this.options.logSink?.appendLine(
        `[acp] Native resume failed; falling back to reconstructed context: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * The MCP servers to advertise on this session. `stdio` is the one transport
   * every ACP agent must support; `http` is only sent when the agent said it
   * supports it in its `initialize` response.
   */
  private mcpServersForSession(): acp.McpServer[] {
    const httpSupported = this.initializeResponse?.agentCapabilities?.mcpCapabilities?.http === true;
    const servers: acp.McpServer[] = [];
    for (const server of this.options.mcpServers ?? []) {
      if ('command' in server) {
        servers.push({
          name: server.name,
          command: server.command,
          args: server.args ?? [],
          env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value }))
        });
      } else if (httpSupported) {
        servers.push({
          type: 'http' as const,
          name: server.name,
          url: server.url,
          headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value }))
        });
      }
    }
    return servers;
  }

  /** Creates the ACP session on first call (`session/new`); returns the existing one otherwise. */
  private async ensureSession(): Promise<acp.ActiveSession> {
    if (!this.connection) {
      throw new Error('ACP client is not connected.');
    }
    if (!this.session) {
      let builder = this.connection.agent.buildSession(this.options.workingDirectory);
      for (const mcpServer of this.mcpServersForSession()) {
        builder = builder.withMcpServer(mcpServer);
      }
      this.session = await builder.start();
    }
    return this.session;
  }

  /**
   * The session's `model`-category config option (its available models and
   * which is currently selected), if the agent exposes one — from
   * `session/new`'s response. Creates the session if it hasn't started yet;
   * safe to call before ever prompting, since `session/new` triggers no
   * prompt/completion of its own (no cost, just protocol data).
   */
  public async getModelOption(): Promise<acp.SessionConfigOption | undefined> {
    return this.getConfigOption('model', 'model');
  }

  /** Finds a session option by semantic category, with an id fallback for
   * older agents that predate ACP's category field. */
  public async getConfigOption(category: string, fallbackId?: string): Promise<acp.SessionConfigOption | undefined> {
    const options = await this.tryResumeSession()
      ? this.resumedConfigOptions
      : (await this.ensureSession()).newSessionResponse.configOptions;
    return options?.find(option => option.category === category) ??
      (fallbackId ? options?.find(option => option.id === fallbackId) : undefined);
  }

  /** Sets a session config option (e.g. `model`) via `session/set_config_option`. */
  public async setConfigOption(configId: string, value: string): Promise<void> {
    if (!this.connection || !this.acpModule) {
      throw new Error('ACP client is not connected.');
    }
    if (await this.tryResumeSession()) {
      await this.connection.agent.request(this.acpModule.AGENT_METHODS.session_set_config_option, {
        sessionId: this.resumedSessionId!,
        configId,
        value
      });
      return;
    }
    const session = await this.ensureSession();
    await this.connection.agent.request(this.acpModule.AGENT_METHODS.session_set_config_option, {
      sessionId: session.sessionId,
      configId,
      value
    });
  }

  /**
   * The session's Session Modes (e.g. "ask" / "architect" / "code"), if the
   * agent advertises any — from `session/new`'s response. Same no-cost shape
   * as `getModelOption`: creates the session if needed, triggers no prompt.
   */
  public async getSessionModes(): Promise<acp.SessionModeState | null | undefined> {
    const session = await this.ensureSession();
    return session.modes;
  }

  /**
   * Switches the agent's own operating mode via `session/set_mode`. Distinct
   * from Praxis's own `SessionMode` (chat/analysis/review) — this is entirely
   * the agent's protocol-level state, unrelated to that.
   */
  public async setMode(modeId: string): Promise<void> {
    if (!this.connection || !this.acpModule) {
      throw new Error('ACP client is not connected.');
    }
    if (await this.tryResumeSession()) {
      await this.connection.agent.request(this.acpModule.AGENT_METHODS.session_set_mode, {
        sessionId: this.resumedSessionId!,
        modeId
      });
      return;
    }
    const session = await this.ensureSession();
    await this.connection.agent.request(this.acpModule.AGENT_METHODS.session_set_mode, {
      sessionId: session.sessionId,
      modeId
    });
  }

  /** Gracefully closes a protocol session before the stdio transport is torn down. */
  public async closeSession(): Promise<void> {
    if (!this.connection || !this.acpModule) return;
    const sessionId = this.resumedSessionId ?? this.session?.sessionId;
    if (!sessionId || !this.initializeResponse?.agentCapabilities?.sessionCapabilities?.close) return;
    try {
      await this.connection.agent.request(this.acpModule.AGENT_METHODS.session_close, { sessionId });
    } catch {
      // The process may already have exited; dispose() still handles the transport safely.
    }
  }

  /**
   * Lets short-lived ACP probes finish before tearing down stdio. Some CLI
   * adapters do not advertise `session/close`; killing those immediately can
   * make their final JSON-RPC write hit a closed pipe and crash with EPIPE.
   * The wait resolves as soon as the child exits, so a well-behaved adapter
   * adds no latency; the cap only bounds the worst case for an adapter that
   * never exits on stdin close. Callers like `listAvailableModels()` run this
   * on every invocation (its own doc comment calls that path "no cost"), so
   * the cap is kept short rather than a full second.
   */
  public async shutdown(): Promise<void> {
    if (this.disposed || this.shuttingDown) return;
    this.shuttingDown = true;
    await this.closeSession();
    const child = this.child;
    if (child && !child.killed && child.stdin && !child.stdin.destroyed) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.stdin.end();
      await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 300))]);
    }
    this.dispose();
  }

  /**
   * Waits for resumed-session replay notifications to stop arriving before
   * the prompt gate opens. Polls for a quiet window rather than trusting one
   * fixed delay, so a slow or bursty replay still finishes draining; capped
   * so a provider whose replay never quiets down can't hang the turn.
   */
  private async waitForReplayToQuiet(): Promise<void> {
    const quietWindowMs = 50;
    const maxWaitMs = 500;
    const pollMs = 20;
    const deadline = Date.now() + maxWaitMs;
    this.lastReplayNotificationAt = Date.now();
    while (Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, pollMs));
      if (Date.now() - this.lastReplayNotificationAt >= quietWindowMs) {
        return;
      }
    }
  }

  /**
   * Starts a new session and runs one prompt turn to completion, streaming
   * `session/update`s to `onSessionUpdate` as they arrive.
   *
   * `images`, when present, ride alongside `text` as ACP `ImageContent`
   * blocks (base64 + mimeType — exactly `WireImageAttachment`'s shape). No
   * `PromptCapabilities.image` negotiation happens here: every ACP host this
   * app currently targets (Claude Code, Codex, Copilot) accepts image
   * blocks, and an agent that genuinely can't would reject the request with
   * a normal protocol error, surfaced the same way any other prompt failure
   * already is.
   */
  public async prompt(text: string, images?: readonly WireImageAttachment[]): Promise<acp.PromptResponse> {
    try {
      return await this.promptInner(text, images);
    } catch (error) {
      throw withAgentErrorDetail(error);
    }
  }

  private async promptInner(text: string, images?: readonly WireImageAttachment[]): Promise<acp.PromptResponse> {
    const promptContent: string | acp.ContentBlock[] = images?.length
      ? [
          { type: 'text', text },
          ...images.map(image => ({ type: 'image' as const, data: image.dataBase64, mimeType: image.mimeType }))
        ]
      : text;
    if (await this.tryResumeSession()) {
      if (!this.connection || !this.acpModule) throw new Error('ACP client is not connected.');
      // Let replay notifications queued by session/resume or session/load
      // drain while the prompt gate is still closed, rather than trusting one
      // fixed delay: they cross a subprocess pipe, so a slow or bursty flush
      // can still be arriving after any single fixed wait.
      await this.waitForReplayToQuiet();
      this.promptInFlight = true;
      try {
        return await this.connection.agent.request(this.acpModule.AGENT_METHODS.session_prompt, {
          sessionId: this.resumedSessionId!,
          prompt: typeof promptContent === 'string' ? [{ type: 'text', text: promptContent }] : promptContent
        });
      } finally {
        this.promptInFlight = false;
      }
    }
    const session = await this.ensureSession();
    const promptPromise = session.prompt(promptContent);
    for (;;) {
      const message = await session.nextUpdate();
      if (message.kind === 'session_update') {
        this.options.onSessionUpdate(message.update);
        continue;
      }
      break;
    }
    // The 'stop' message and `promptPromise` settle from the same turn;
    // await the promise directly so a request-level rejection propagates.
    return promptPromise;
  }

  /** Requests the agent cancel the in-flight prompt turn (`session/cancel`). */
  public async cancel(): Promise<void> {
    if (!this.connection || (!this.session && !this.resumedSessionId)) {
      return;
    }
    const acpModule: typeof acp = await import('@agentclientprotocol/sdk');
    await this.connection.agent.notify(acpModule.AGENT_METHODS.session_cancel, {
      sessionId: this.resumedSessionId ?? this.session!.sessionId
    });
  }

  /** Closes the connection and kills the subprocess. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    // Terminate the child before closing the JSON-RPC streams. Closing the
    // streams first can make an ACP adapter write to a closed stdout pipe and
    // crash it with an unhandled EPIPE while it is flushing session/query.
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.session?.dispose();
    this.connection?.close();
  }
}
