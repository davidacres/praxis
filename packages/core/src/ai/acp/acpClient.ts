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

  constructor(private readonly options: AcpClientOptions) {}

  /** Spawns the agent subprocess and completes the ACP `initialize` handshake. */
  public async connect(): Promise<void> {
    const acpModule: typeof acp = await import('@agentclientprotocol/sdk');

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

    const app = acpModule.client({ name: 'ticket-manager' });

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
      const path = resolveSandboxedPath(this.options.workingDirectory, ctx.params.path);
      await nodeFs.writeFile(path, ctx.params.content, 'utf8');
    });

    this.connection = app.connect(stream);

    await this.connection.agent.request(acpModule.AGENT_METHODS.initialize, {
      protocolVersion: acpModule.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: 'ticket-manager', version: '0.0.0' }
    });
  }

  /**
   * Starts a new session and runs one prompt turn to completion, streaming
   * `session/update`s to `onSessionUpdate` as they arrive.
   */
  public async prompt(text: string): Promise<acp.PromptResponse> {
    if (!this.connection) {
      throw new Error('ACP client is not connected.');
    }
    if (!this.session) {
      this.session = await this.connection.agent.buildSession(this.options.workingDirectory).start();
    }
    const promptPromise = this.session.prompt(text);
    for (;;) {
      const message = await this.session.nextUpdate();
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
    if (!this.connection || !this.session) {
      return;
    }
    const acpModule: typeof acp = await import('@agentclientprotocol/sdk');
    await this.connection.agent.notify(acpModule.AGENT_METHODS.session_cancel, {
      sessionId: this.session.sessionId
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
