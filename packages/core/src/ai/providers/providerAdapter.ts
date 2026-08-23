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
  /** Executable spawned on PATH by default (e.g. `claude-agent-acp`); overridable via `AiProviderConfig.cliPath`. */
  defaultCommand: string;
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
