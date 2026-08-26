// Type-only import: `@github/copilot-sdk`'s package.json declares
// `"type": "module"` and both its `import`/`require` conditions point at the
// same `dist/index.d.ts`, so under this package's Node16 module resolution
// TypeScript treats that one .d.ts as ESM-format regardless of which
// condition resolved it — a static value import trips TS1479 even though
// the package does ship a real `dist/cjs/index.js` and plain `require()`
// works fine at runtime. Type-only imports are erased, so they sidestep the
// check; the runtime module loads via dynamic `import()` in `connect()`
// instead — the same CJS→ESM interop pattern `acpClient.ts` uses for ACP.
import type * as copilotSdk from '@github/copilot-sdk' with { 'resolution-mode': 'import' };
import type { LogSink } from '../../host/logSink';
import type { PermissionDecision } from '../tools';

/**
 * Thin host-side wrapper around `@github/copilot-sdk`'s `CopilotClient` —
 * the Copilot peer of `AcpClientWrapper`.
 *
 * The SDK spawns and manages its own bundled `@github/copilot` runtime by
 * default (`RuntimeConnection.forStdio()`), so — unlike the ACP path —
 * there's no separate adapter binary to install; `runtimePath` only matters
 * as an override for a non-default runtime location.
 */

export interface CopilotPermissionRequest {
  kind: string;
  title: string;
  detail?: string;
}

export interface CopilotToolEvent {
  phase: 'start' | 'complete';
  toolCallId: string;
  toolName: string;
  success?: boolean;
}

export interface CopilotClientOptions {
  /** Working directory for the runtime process and the session's file sandbox. */
  workingDirectory: string;
  /** Overrides the bundled runtime executable; omit to use the SDK default. */
  runtimePath?: string;
  model?: string;
  /** Provider-owned Copilot session to resume with complete native history. */
  resumeSessionId?: string;
  requestPermission: (request: CopilotPermissionRequest) => Promise<PermissionDecision>;
  onMessageDelta: (text: string) => void;
  onToolEvent?: (event: CopilotToolEvent) => void;
  logSink?: LogSink;
}

/** Turns one of the SDK's ten `PermissionRequest` kinds into a short human summary for the approval card. */
function summarizePermissionRequest(request: copilotSdk.PermissionRequest): CopilotPermissionRequest {
  switch (request.kind) {
    case 'shell':
      return { kind: request.kind, title: `Run shell command: ${request.fullCommandText}`, detail: request.intention };
    case 'write':
      return { kind: request.kind, title: `Write file: ${request.fileName}`, detail: request.intention };
    case 'read':
      return { kind: request.kind, title: `Read file: ${request.path}`, detail: request.intention };
    case 'mcp':
      return { kind: request.kind, title: `Run MCP tool: ${request.toolTitle}`, detail: `Server: ${request.serverName}` };
    case 'url':
      return { kind: request.kind, title: `Fetch URL: ${request.url}`, detail: request.intention };
    case 'memory':
      return { kind: request.kind, title: 'Store a memory', detail: request.fact };
    case 'custom-tool':
      return { kind: request.kind, title: `Run tool: ${request.toolName}`, detail: request.toolDescription };
    case 'hook':
      return { kind: request.kind, title: `Confirm: ${request.toolName}`, detail: request.hookMessage };
    case 'extension-management':
      return {
        kind: request.kind,
        title: `Extension ${request.operation}${request.extensionName ? `: ${request.extensionName}` : ''}`
      };
    case 'factory':
      return { kind: request.kind, title: `Run factory: ${request.name}`, detail: request.description };
    case 'extension-permission-access':
      return {
        kind: request.kind,
        title: `Extension permission access: ${request.extensionName}`,
        detail: request.capabilities.join(', ')
      };
    default:
      return { kind: (request as { kind: string }).kind, title: 'Permission request' };
  }
}

/** Maps our 3-way local permission decision onto the SDK's decision union. */
function toPermissionResult(decision: PermissionDecision): copilotSdk.PermissionRequestResult {
  switch (decision) {
    case 'allow_once':
      return { kind: 'approve-once' };
    case 'allow_always':
      return { kind: 'approve-for-session' };
    case 'deny':
      return { kind: 'reject' };
  }
}

export class CopilotClientWrapper {
  private client?: copilotSdk.CopilotClient;
  private session?: copilotSdk.CopilotSession;

  constructor(private readonly options: CopilotClientOptions) {}

  public get sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  /** Starts (or connects to) the Copilot runtime. Does not create a session yet — `prompt()` does that lazily on first use. */
  public async connect(): Promise<void> {
    const sdk: typeof copilotSdk = await import('@github/copilot-sdk');
    this.client = new sdk.CopilotClient({
      workingDirectory: this.options.workingDirectory,
      connection: this.options.runtimePath ? sdk.RuntimeConnection.forStdio({ path: this.options.runtimePath }) : undefined,
      logLevel: 'error'
    });
    await this.client.start();
  }

  /**
   * Sends one prompt and waits for the assistant's reply, streaming delta
   * chunks to `onMessageDelta` as they arrive. Creates the session lazily on
   * the first call so a fresh session backs every task.
   */
  public async prompt(text: string): Promise<{ content: string; errored: boolean }> {
    if (!this.client) {
      throw new Error('Copilot client is not connected.');
    }
    if (!this.session) {
      const sessionConfig = {
        clientName: 'ticket-manager',
        model: this.options.model,
        onPermissionRequest: async (request: copilotSdk.PermissionRequest) =>
          toPermissionResult(await this.options.requestPermission(summarizePermissionRequest(request)))
      };
      this.session = this.options.resumeSessionId
        ? await this.client.resumeSession(this.options.resumeSessionId, sessionConfig)
        : await this.client.createSession(sessionConfig);
      this.session.on('assistant.message_delta', event => {
        this.options.onMessageDelta(event.data.deltaContent);
      });
      this.session.on('session.error', event => {
        this.options.logSink?.appendLine(`[copilot:error] ${event.data.errorType}: ${event.data.message}`);
      });
      this.session.on('tool.execution_start', event => {
        this.options.onToolEvent?.({ phase: 'start', toolCallId: event.data.toolCallId, toolName: event.data.toolName });
      });
      this.session.on('tool.execution_complete', event => {
        this.options.onToolEvent?.({
          phase: 'complete',
          toolCallId: event.data.toolCallId,
          toolName: event.data.toolDescription?.name ?? event.data.toolCallId,
          success: event.data.success
        });
      });
    }
    const response = await this.session.sendAndWait(text);
    if (!response) {
      return { content: '', errored: true };
    }
    return { content: response.data.content, errored: false };
  }

  /** Cancels the in-flight prompt turn, if any. */
  public async cancel(): Promise<void> {
    if (!this.session) {
      return;
    }
    await this.session.abort().catch(() => {});
  }

  /** Disconnects the session and stops the runtime process. */
  public dispose(): void {
    const session = this.session;
    const client = this.client;
    this.session = undefined;
    this.client = undefined;
    void session?.disconnect().catch(() => {});
    void client?.stop().catch(() => {});
  }
}
