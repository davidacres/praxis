import type { ProviderAuth } from './customProviders';

/** Where a preset sits in Settings → AI Provider → Add provider. */
export type ProviderPresetGroup = 'cloud' | 'local' | 'custom';

/**
 * A template for a user-added OpenAI-compatible endpoint. Adding one copies
 * its URL / path / auth into a new `CustomProviderConfig`; the preset itself is
 * never referenced for connection details again, so a later app version that
 * changes a preset never rewrites a saved endpoint.
 *
 * No default model ids on purpose: they go stale within months. The model
 * comes from the server's `/models`, or the user types it.
 */
export interface ProviderPreset {
  id: string;
  label: string;
  group: ProviderPresetGroup;
  /** One line under the name in the catalog. */
  note: string;
  baseUrl: string;
  apiPath: string;
  auth: ProviderAuth;
  /** False for local runtimes that normally run without a key. */
  keyRequired: boolean;
  /** Where to create a key, when the provider has a console for it. */
  keyUrl?: string;
}

/**
 * The catalog. Each URL is the vendor's documented OpenAI-compatible base; it
 * is copied into the endpoint and stays editable, so a vendor moving its API
 * is a one-field fix for the user, not a release.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'openrouter', label: 'OpenRouter', group: 'cloud', note: 'Hundreds of models behind one key', baseUrl: 'https://openrouter.ai', apiPath: '/api/v1', auth: { kind: 'bearer' }, keyRequired: true, keyUrl: 'https://openrouter.ai/keys' },
  { id: 'groq', label: 'Groq', group: 'cloud', note: 'Fast open-weight models', baseUrl: 'https://api.groq.com', apiPath: '/openai/v1', auth: { kind: 'bearer' }, keyRequired: true, keyUrl: 'https://console.groq.com/keys' },
  { id: 'mistral', label: 'Mistral', group: 'cloud', note: 'Mistral and Codestral models', baseUrl: 'https://api.mistral.ai', apiPath: '/v1', auth: { kind: 'bearer' }, keyRequired: true, keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'deepseek', label: 'DeepSeek', group: 'cloud', note: 'DeepSeek chat and reasoning models', baseUrl: 'https://api.deepseek.com', apiPath: '/v1', auth: { kind: 'bearer' }, keyRequired: true, keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'xai', label: 'xAI', group: 'cloud', note: 'Grok models', baseUrl: 'https://api.x.ai', apiPath: '/v1', auth: { kind: 'bearer' }, keyRequired: true, keyUrl: 'https://console.x.ai' },
  { id: 'together', label: 'Together AI', group: 'cloud', note: 'Hosted open-weight models', baseUrl: 'https://api.together.xyz', apiPath: '/v1', auth: { kind: 'bearer' }, keyRequired: true, keyUrl: 'https://api.together.ai/settings/api-keys' },
  { id: 'fireworks', label: 'Fireworks', group: 'cloud', note: 'Hosted open-weight models', baseUrl: 'https://api.fireworks.ai', apiPath: '/inference/v1', auth: { kind: 'bearer' }, keyRequired: true, keyUrl: 'https://fireworks.ai/account/api-keys' },
  { id: 'cerebras', label: 'Cerebras', group: 'cloud', note: 'Fast inference on Cerebras hardware', baseUrl: 'https://api.cerebras.ai', apiPath: '/v1', auth: { kind: 'bearer' }, keyRequired: true, keyUrl: 'https://cloud.cerebras.ai' },
  { id: 'ollama', label: 'Ollama', group: 'local', note: 'No key · localhost:11434', baseUrl: 'http://localhost:11434', apiPath: '/v1', auth: { kind: 'none' }, keyRequired: false },
  { id: 'lm-studio', label: 'LM Studio', group: 'local', note: 'No key · localhost:1234', baseUrl: 'http://localhost:1234', apiPath: '/v1', auth: { kind: 'none' }, keyRequired: false },
  { id: 'vllm', label: 'vLLM', group: 'local', note: 'Optional key · localhost:8000', baseUrl: 'http://localhost:8000', apiPath: '/v1', auth: { kind: 'none' }, keyRequired: false },
  { id: 'llama-cpp', label: 'llama.cpp server', group: 'local', note: 'No key · localhost:8080', baseUrl: 'http://localhost:8080', apiPath: '/v1', auth: { kind: 'none' }, keyRequired: false },
  { id: 'custom', label: 'Custom OpenAI-compatible endpoint', group: 'custom', note: 'Any server that speaks /chat/completions — you supply the URL, auth and models.', baseUrl: '', apiPath: '/v1', auth: { kind: 'bearer' }, keyRequired: true }
];

export function findProviderPreset(id: string | undefined): ProviderPreset | undefined {
  return id ? PROVIDER_PRESETS.find(preset => preset.id === id) : undefined;
}
