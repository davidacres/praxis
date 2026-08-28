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
  kind?: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export interface AcpClientOptions {
  /** Executable to spawn (e.g. `claude-agent-acp`, `codex-acp`), resolved on PATH or an absolute path. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Session cwd and the fs sandbox root for `fs/read_text_file`/`fs/write_text_file`. */
  workingDirectory: string;
  toolMode?: AgentToolMode;
  /** Provider-owned ACP session to resume when supported by the agent. */
  resumeSessionId?: string;
  requestPermission: (request: AcpPermissionRequest) => Promise<PermissionDecision>;
  onSessionUpdate: (update: acp.SessionUpdate) => void;
  logSink?: LogSink;
}

/** Maps our 3-way local permission decision onto whichever ACP option the agent actually offered. */
function pickPermissionOptionId(
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
    const match = options.find(o => o.kind === kind);
    if (match) {
      return match.optionId;
    }
  }
  return options[0]?.optionId;
}

export class AcpClientWrapper {
  private child?: ChildProcess;
  private connection?: acp.ClientConnection;
  private session?: acp.ActiveSession;
  private acpModule?: typeof acp;
  private initializeResponse?: acp.InitializeResponse;
  private resumedSessionId?: string;
  private resumeAttempted = false;

  constructor(private readonly options: AcpClientOptions) {}

  /** Spawns the agent subprocess and completes the ACP `initialize` handshake. */
  public async connect(): Promise<void> {
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
    child.on('error', err => {
      this.options.logSink?.appendLine(`[acp] subprocess error: ${err.message}`);
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
      if (this.resumedSessionId && ctx.params.sessionId === this.resumedSessionId) {
        this.options.onSessionUpdate(ctx.params.update);
      }
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
  }

  /** Provider-owned session id, available after session creation or successful native resume. */
  public get sessionId(): string | undefined {
    return this.resumedSessionId ?? this.session?.sessionId;
  }

  private async tryResumeSession(): Promise<boolean> {
    if (this.resumeAttempted) return Boolean(this.resumedSessionId);
    this.resumeAttempted = true;
    const sessionId = this.options.resumeSessionId?.trim();
    if (!sessionId || !this.connection || !this.acpModule || !this.initializeResponse) return false;
    const capabilities = this.initializeResponse.agentCapabilities;
    if (!capabilities) return false;
    try {
      if (capabilities.sessionCapabilities?.resume) {
        await this.connection.agent.request(this.acpModule.AGENT_METHODS.session_resume, {
          sessionId,
          cwd: this.options.workingDirectory,
          additionalDirectories: []
        });
      } else if (capabilities.loadSession) {
        await this.connection.agent.request(this.acpModule.AGENT_METHODS.session_load, {
          sessionId,
          cwd: this.options.workingDirectory,
          mcpServers: [],
          additionalDirectories: []
        });
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

  /** Creates the ACP session on first call (`session/new`); returns the existing one otherwise. */
  private async ensureSession(): Promise<acp.ActiveSession> {
    if (!this.connection) {
      throw new Error('ACP client is not connected.');
    }
    if (!this.session) {
      this.session = await this.connection.agent.buildSession(this.options.workingDirectory).start();
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
    const session = await this.ensureSession();
    return session.newSessionResponse.configOptions?.find(option => option.id === 'model');
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
   * Starts a new session and runs one prompt turn to completion, streaming
   * `session/update`s to `onSessionUpdate` as they arrive.
   */
  public async prompt(text: string): Promise<acp.PromptResponse> {
    if (await this.tryResumeSession()) {
      if (!this.connection || !this.acpModule) throw new Error('ACP client is not connected.');
      return this.connection.agent.request(this.acpModule.AGENT_METHODS.session_prompt, {
        sessionId: this.resumedSessionId!,
        prompt: [{ type: 'text', text }]
      });
    }
    const session = await this.ensureSession();
    const promptPromise = session.prompt(text);
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
    this.session?.dispose();
    this.connection?.close();
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
  }
}
