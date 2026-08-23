import type { AiProvider } from '../../types';
import { DEFAULT_VERCEL_URL } from '../gateway/modelIds';
import { anthropicAdapter } from './anthropicAdapter';
import { openAiCompatibleAdapter } from './openAiCompatibleAdapter';
import type { ProviderAdapter, ProviderDescriptor } from './providerAdapter';

/** Developer-maintained provider registry — not user-editable. Unlike a plain
 * "URL + key" source list, each provider here has real adapter code because
 * their wire protocols genuinely differ (OpenAI-compatible vs. Anthropic
 * Messages vs., in Phase 2, a subprocess-hosted CLI agent). */
export const PROVIDER_DESCRIPTORS: Record<AiProvider, ProviderDescriptor> = {
  'vercel-gateway': {
    id: 'vercel-gateway',
    kind: 'api',
    label: 'Vercel AI Gateway',
    defaultBaseUrl: DEFAULT_VERCEL_URL,
    defaultModel: 'anthropic/claude-sonnet-4.6'
  },
  openai: {
    id: 'openai',
    kind: 'api',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com',
    defaultModel: 'gpt-4o-mini'
  },
  anthropic: {
    id: 'anthropic',
    kind: 'api',
    label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-6'
  },
  'claude-code-cli': {
    id: 'claude-code-cli',
    kind: 'cli-agent',
    label: 'Claude Code (local)',
    // @agentclientprotocol/claude-agent-acp's bin — an ACP-compatible
    // wrapper around the Claude Agent SDK. Confirmed on npm at
    // implementation time; the user must have it (or an npx-resolvable
    // equivalent) available.
    defaultCommand: 'claude-agent-acp'
  },
  'codex-cli': {
    id: 'codex-cli',
    kind: 'cli-agent',
    label: 'Codex CLI (local)',
    // @agentclientprotocol/codex-acp's bin — the official ACP adapter for
    // OpenAI's Codex CLI.
    defaultCommand: 'codex-acp'
  }
};

const ADAPTERS: Partial<Record<AiProvider, ProviderAdapter>> = {
  'vercel-gateway': openAiCompatibleAdapter,
  openai: openAiCompatibleAdapter,
  anthropic: anthropicAdapter
};

/** Only valid for `kind: 'api'` providers — `kind: 'cli-agent'` providers use `AcpAgentHost` instead. */
export function resolveProviderAdapter(id: AiProvider): ProviderAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new Error(`Provider '${id}' has no chat-completions adapter (kind: '${PROVIDER_DESCRIPTORS[id].kind}').`);
  }
  return adapter;
}
