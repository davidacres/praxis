import type { AiProvider } from '../../types';
import type { ChatStreamHandle, GatewayOptions } from '../gateway/gatewayClient';
import type { BuildChatRequestArgs, StreamChatEvent } from '../gateway/wire';

export type ProviderKind = 'api' | 'cli-agent';

export interface ApiProviderDescriptor {
  id: AiProvider;
  kind: 'api';
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
}

export interface CliAgentProviderDescriptor {
  id: AiProvider;
  kind: 'cli-agent';
  label: string;
  /**
   * Every CLI-hosted agent — Claude Code, Codex, and GitHub Copilot — is
   * driven the same way: an ACP-compatible subprocess over stdio JSON-RPC,
   * via `AcpAgentHost`. (Copilot previously had its own bespoke
   * `hostKind: 'copilot-sdk'` path through `@github/copilot-sdk`; GitHub
   * added a `copilot --acp` server mode, confirmed to report models via a
   * standard `model`-category `session/new` config option and to emit the
   * same `tool_call`/`session/request_permission` shapes Claude/Codex do, so
   * Copilot converged onto this one path rather than keeping a second.)
   */
  hostKind: 'acp';
  /** Executable spawned on PATH by default (e.g. `claude-agent-acp`, `copilot`); overridable via `AiProviderConfig.cliPath`. */
  defaultCommand?: string;
  /** Fixed args always passed to `defaultCommand` (e.g. Copilot's `['--acp']`) — not overridable via settings. */
  defaultArgs?: string[];
}

export type ProviderDescriptor = ApiProviderDescriptor | CliAgentProviderDescriptor;

/**
 * Everything `agentLoop.ts` needs to drive one turn against a provider's wire
 * protocol, keeping the loop itself provider-agnostic. `WireMessage[]` (the
 * OpenAI-compatible shape in `gateway/wire.ts`) stays the one canonical
 * internal/persisted conversation representation — an adapter's job is only
 * to translate to/from its own wire format at the edges.
 */
export interface ProviderAdapter {
  buildChatRequest(args: BuildChatRequestArgs): unknown;
  postChatStream(
    opts: GatewayOptions,
    payload: unknown,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<ChatStreamHandle>;
  consumeChatStream(lines: AsyncIterable<string>, signal?: AbortSignal): AsyncGenerator<StreamChatEvent>;
}
