import type { AiProvider } from '../../types';
import { DEFAULT_VERCEL_URL } from '../gateway/modelIds';
import { anthropicAdapter } from './anthropicAdapter';
import { geminiAdapter } from './geminiAdapter';
import { DEFAULT_GEMINI_BASE_URL } from './geminiClient';
import { openAiCompatibleAdapter } from './openAiCompatibleAdapter';
import type { ProviderAdapter, ProviderDescriptor } from './providerAdapter';

/** Developer-maintained provider registry — not user-editable. Unlike a plain
 * "URL + key" source list, each provider here has real adapter code because
 * their wire protocols genuinely differ (OpenAI-compatible vs. Anthropic
 * Messages vs. Google Gemini vs., in Phase 2, a subprocess-hosted CLI agent). */
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
  gemini: {
    id: 'gemini',
    kind: 'api',
    label: 'Google Gemini',
    defaultBaseUrl: DEFAULT_GEMINI_BASE_URL,
    defaultModel: 'gemini-2.5-flash'
  },
  'z-ai': {
    id: 'z-ai',
    kind: 'api',
    label: 'Z.ai',
    defaultBaseUrl: 'https://api.z.ai',
    defaultModel: 'glm-5.3',
    apiPath: '/api/coding/paas/v4'
  },
  'claude-code-cli': {
    id: 'claude-code-cli',
    kind: 'cli-agent',
    hostKind: 'acp',
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
    hostKind: 'acp',
    label: 'Codex CLI (local)',
    // @agentclientprotocol/codex-acp's bin — the official ACP adapter for
    // OpenAI's Codex CLI.
    defaultCommand: 'codex-acp'
  },
  'copilot-cli': {
    id: 'copilot-cli',
    kind: 'cli-agent',
    hostKind: 'acp',
    label: 'GitHub Copilot (local)',
    // `copilot --acp` (public preview, added by GitHub) starts the Copilot
    // CLI as a standard ACP server over stdio — same protocol as the
    // `claude-agent-acp`/`codex-acp` wrappers above. `defaultCommand` is the
    // bare `copilot` binary; `defaultArgs` supplies the `--acp` flag every
    // launch needs, since (unlike the other two) this binary defaults to its
    // own interactive/print modes without it.
    defaultCommand: 'copilot',
    defaultArgs: ['--acp']
  },
  'antigravity-cli': {
    id: 'antigravity-cli',
    kind: 'cli-agent',
    hostKind: 'acp',
    label: 'Antigravity',
    defaultCommand: 'antigravity-acp'
  }
};

const ADAPTERS: Partial<Record<AiProvider, ProviderAdapter>> = {
  'vercel-gateway': openAiCompatibleAdapter,
  openai: openAiCompatibleAdapter,
  'z-ai': openAiCompatibleAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter
};

/** Only valid for `kind: 'api'` providers — `kind: 'cli-agent'` providers use `AcpAgentHost` instead. */
export function resolveProviderAdapter(id: AiProvider): ProviderAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new Error(`Provider '${id}' has no chat-completions adapter (kind: '${PROVIDER_DESCRIPTORS[id].kind}').`);
  }
  return adapter;
}
