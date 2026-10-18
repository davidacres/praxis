import type { AiProvider, AiProviderStatus, CustomProviderConfig, ProviderPreset } from '@praxis/core';

export type AiTab = 'providers' | 'routing' | 'behaviour' | 'tools';

export interface AiProviderMeta {
  id: AiProvider;
  kind: 'api' | 'cli-agent';
  label: string;
  keyLabel: string;
  urlPlaceholder: string;
  modelPlaceholder: string;
  /** `kind: 'api'` only — where the provider's console creates a key. */
  keyUrl?: string;
  /** `kind: 'cli-agent'` only — default PATH-resolved executable name. Absent for the Copilot SDK's own bundled runtime. */
  defaultCommand?: string;
  /** `kind: 'cli-agent'` only — overrides the generic "CLI path" field's description. */
  cliPathDescription?: string;
  /** `kind: 'cli-agent'` only — shown when the real, free PATH-resolution check finds nothing to spawn. */
  notInstalledHint?: string;
  /** `kind: 'cli-agent'` only — fixed package Praxis may install after confirmation. */
  installPackage?: string;
  /** `kind: 'cli-agent'` only — how to sign the agent in; it keeps its own login, Praxis never sees it. */
  signIn?: { command?: string; text: string };
}

/** Short names for a custom endpoint's tested capabilities. */
export const CAPABILITY_LABELS = {
  models: 'Models',
  chat: 'Chat',
  streamUsage: 'Streaming usage',
  tools: 'Tool calling'
} as const;

/** Display metadata for the settings UI — mirrors core's `PROVIDER_DESCRIPTORS`
 *  (kept as a local literal, not imported: core drags in Node built-ins that
 *  can't bundle into the renderer, same reason `settingsDefaults.ts` exists). */
export const AI_PROVIDERS: AiProviderMeta[] = [
  {
    id: 'vercel-gateway',
    kind: 'api',
    label: 'Vercel AI Gateway',
    keyLabel: 'Vercel AI Gateway API key',
    urlPlaceholder: 'https://ai-gateway.vercel.sh',
    modelPlaceholder: 'e.g. anthropic/claude-sonnet-4.6'
  },
  {
    id: 'openai',
    kind: 'api',
    label: 'OpenAI',
    keyLabel: 'OpenAI API key',
    urlPlaceholder: 'https://api.openai.com',
    modelPlaceholder: 'e.g. gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'anthropic',
    kind: 'api',
    label: 'Anthropic',
    keyLabel: 'Anthropic API key',
    urlPlaceholder: 'https://api.anthropic.com',
    modelPlaceholder: 'e.g. claude-sonnet-4-6',
    keyUrl: 'https://console.anthropic.com/settings/keys'
  },
  {
    id: 'gemini',
    kind: 'api',
    label: 'Google Gemini',
    keyLabel: 'Gemini API key',
    urlPlaceholder: 'https://generativelanguage.googleapis.com',
    modelPlaceholder: 'e.g. gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey'
  },
  {
    id: 'z-ai',
    kind: 'api',
    label: 'Z.ai',
    keyLabel: 'Z.ai API key',
    urlPlaceholder: 'https://api.z.ai/api/coding/paas/v4',
    modelPlaceholder: 'e.g. glm-5.3'
  },
  {
    id: 'claude-code-cli',
    kind: 'cli-agent',
    label: 'Claude Code (local)',
    keyLabel: '',
    urlPlaceholder: '',
    modelPlaceholder: '',
    defaultCommand: 'claude-agent-acp',
    notInstalledHint: 'Not found on PATH — install the ACP package or set the executable path below.',
    installPackage: '@agentclientprotocol/claude-agent-acp',
    signIn: { command: 'claude', text: 'Run once and sign in — it keeps its own login.' }
  },
  {
    id: 'codex-cli',
    kind: 'cli-agent',
    label: 'OpenAI Codex (local)',
    keyLabel: '',
    urlPlaceholder: '',
    modelPlaceholder: '',
    defaultCommand: 'codex-acp',
    notInstalledHint: 'Not found on PATH — install the ACP package or set the executable path below.',
    installPackage: '@agentclientprotocol/codex-acp',
    signIn: { command: 'codex login', text: 'Run once in a terminal — Codex keeps its own login.' }
  },
  {
    id: 'copilot-cli',
    kind: 'cli-agent',
    label: 'GitHub Copilot (local)',
    keyLabel: '',
    urlPlaceholder: '',
    modelPlaceholder: '',
    cliPathDescription:
      'Runs the bundled @github/copilot runtime automatically — auth comes from GITHUB_TOKEN/gh CLI login, not a stored key. Override with an absolute path only if you need a different runtime executable.',
    notInstalledHint: 'The custom runtime path above was not found.',
    signIn: { command: 'gh auth login', text: 'Copilot uses your GitHub CLI login or GITHUB_TOKEN.' }
  },
  {
    id: 'antigravity-cli',
    kind: 'cli-agent',
    label: 'Antigravity',
    keyLabel: '',
    urlPlaceholder: '',
    modelPlaceholder: '',
    defaultCommand: 'agy',
    notInstalledHint: 'Not found on PATH — install the ACP package or set the executable path below.',
    installPackage: 'agy',
    signIn: { text: 'Antigravity keeps its own sign-in; follow its prompt the first time it runs.' }
  },
  {
    id: 'cursor-cli',
    kind: 'cli-agent',
    label: 'Cursor (local)',
    keyLabel: '',
    urlPlaceholder: '',
    modelPlaceholder: '',
    defaultCommand: 'agent',
    notInstalledHint: 'Not found on PATH — install the Cursor CLI (agent) or set the executable path below.',
    signIn: { command: 'agent login', text: 'Run once in a terminal — Cursor keeps its own login.' }
  }
];

/** "Claude Code (local)" → "Claude Code": the rail already groups local agents, so the suffix is noise there. */
export function shortLabel(meta: Pick<AiProviderMeta, 'label' | 'kind'>): string {
  return meta.kind === 'cli-agent' ? meta.label.replace(/\s*\(local\)$/, '') : meta.label;
}

/** The meta a custom endpoint gets, so every provider renders through one shape. */
export function customMeta(config: Pick<CustomProviderConfig, 'id' | 'label'>): AiProviderMeta {
  return {
    id: config.id,
    kind: 'api',
    label: config.label,
    keyLabel: `${config.label} API key`,
    urlPlaceholder: '',
    modelPlaceholder: ''
  };
}

/** Where a provider sits in the rail. Custom endpoints are their own group; the gateway is a cloud API. */
export type RailGroup = 'cloud' | 'local' | 'endpoints';

export function railGroupOf(meta: AiProviderMeta, custom: boolean): RailGroup {
  if (custom) return 'endpoints';
  return meta.kind === 'cli-agent' ? 'local' : 'cloud';
}

/** A provider's readiness, as the rail dot and the detail header both show it. */
export type ProviderHealth = 'checking' | 'ready' | 'setup' | 'off' | 'chat-only';

export function providerHealth(status: AiProviderStatus | undefined, enabled: boolean): ProviderHealth {
  if (!status) return 'checking';
  if (!status.configured) return 'setup';
  if (!enabled) return 'off';
  if (status.custom && status.capabilities && !status.capabilities.tools) return 'chat-only';
  return 'ready';
}

/** The preset group label a custom endpoint shows as its kind. */
export function endpointKind(config: CustomProviderConfig | undefined, presets: readonly ProviderPreset[]): string {
  if (!config) return 'Cloud API';
  const preset = presets.find(candidate => candidate.id === config.presetId);
  if (preset?.group === 'local') return 'Local server';
  if (preset?.group === 'gateway') return 'Gateway';
  return 'OpenAI-compatible';
}
