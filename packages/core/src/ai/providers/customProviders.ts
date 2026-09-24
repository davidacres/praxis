/**
 * User-added OpenAI-compatible endpoints (FX-BF-044). A built-in provider is
 * code — its own `AiProvider` id and, where the wire protocol differs, its own
 * adapter. A custom endpoint is *data*: a base URL, an API path, an auth style
 * and a few capability flags, all driven through `openAiCompatibleAdapter`.
 *
 * Deliberately dependency-free: `config/appSettings.ts` sanitizes these, and
 * the registry turns them into descriptors, so neither may pull the other in.
 */

/** Id of a user-added endpoint: `custom:<slug>`, stable once created. */
export type CustomProviderId = `custom:${string}`;

/** How the API key is sent. `header` sends it raw under `name` (e.g. `api-key`). */
export type ProviderAuth = { kind: 'bearer' } | { kind: 'none' } | { kind: 'header'; name: string };

export type ProviderProbeStepId = 'models' | 'chat' | 'streaming' | 'tools';

/**
 * What the last connection test found. `tools === false` keeps the endpoint
 * out of agent sessions and workflows (both need tool calling); everything
 * else still works on it.
 */
export interface ProviderCapabilities {
  models: boolean;
  chat: boolean;
  streaming: boolean;
  streamUsage: boolean;
  tools: boolean;
  /** Model the chat/tool steps ran against. */
  model?: string;
  probedAt: string;
}

export interface CustomProviderConfig {
  id: CustomProviderId;
  /** Display name — what pickers and usage reports show. */
  label: string;
  /** Catalog entry it was created from (`ollama`, `openrouter`, … or `custom`). */
  presetId?: string;
  /** Only value in this version; kept so an Anthropic-protocol proxy can be added later. */
  protocol: 'openai-chat';
  /** Server root, http(s) only. */
  baseUrl: string;
  /** Appended to `baseUrl` exactly as given — no `/v1` guessing. Empty means none. */
  apiPath: string;
  auth: ProviderAuth;
  /** Non-secret extra request headers (e.g. OpenRouter's `HTTP-Referer`). */
  headers?: Record<string, string>;
  /** Model ids to offer when the server has no usable `/models`. */
  manualModels?: string[];
  /** Send `stream_options.include_usage`; `false` once a server has rejected it. */
  streamUsage?: boolean;
  capabilities?: ProviderCapabilities;
}

export const CUSTOM_PROVIDER_PREFIX = 'custom:';
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/**
 * `toWorkspaceFile`'s secret rule, widened to the hyphenated `api-key` header
 * form — a header matching it belongs in the keychain, not in settings.
 */
const SECRET_NAME_PATTERN = /token|secret|password|api[-_]?key|\bpat\b/i;
/** Headers the client owns; letting settings override them would break auth or framing. */
const RESERVED_HEADERS = new Set(['authorization', 'content-type', 'content-length', 'accept', 'host']);

export function isCustomProviderId(value: unknown): value is CustomProviderId {
  return typeof value === 'string' && value.startsWith(CUSTOM_PROVIDER_PREFIX) && SLUG_PATTERN.test(value.slice(CUSTOM_PROVIDER_PREFIX.length));
}

/** Why a name can't carry the API key (`auth: header`), or `undefined` when it can. */
export function authHeaderNameProblem(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'Header name is empty.';
  if (!HEADER_NAME_PATTERN.test(trimmed)) return `“${trimmed}” is not a valid header name.`;
  if (RESERVED_HEADERS.has(trimmed.toLowerCase())) return `“${trimmed}” is set by Praxis and can't be overridden.`;
  return undefined;
}

/** Why a header name can't be stored as a plain (non-secret) setting, or `undefined` when it can. */
export function customHeaderNameProblem(name: string): string | undefined {
  const problem = authHeaderNameProblem(name);
  if (problem) return problem;
  if (SECRET_NAME_PATTERN.test(name)) return `“${name.trim()}” looks like a credential — put it in the API key field instead.`;
  return undefined;
}

/** Why a base URL is unusable, or `undefined` when it is fine. */
export function customBaseUrlProblem(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) return 'Enter the server URL.';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'Not a valid URL.';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Use an http:// or https:// URL.';
  if (parsed.username || parsed.password) return 'Put credentials in the API key field, not the URL.';
  return undefined;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** True when a key would cross a network unencrypted: plain http to a host that isn't this machine. */
export function isInsecureRemoteUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Normalizes an API path: `''` stays empty, otherwise one leading slash and no trailing ones. */
export function normalizeApiPath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** A fresh `custom:<slug>` id from a label, unique against `existing`. */
export function customProviderIdFor(label: string, existing: readonly string[]): CustomProviderId {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'endpoint';
  const taken = new Set(existing);
  let slug = base;
  for (let n = 2; taken.has(`${CUSTOM_PROVIDER_PREFIX}${slug}`); n++) slug = `${base}-${n}`;
  return `${CUSTOM_PROVIDER_PREFIX}${slug}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readAuth(value: unknown): ProviderAuth | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'bearer' || value.kind === 'none') return { kind: value.kind };
  if (value.kind === 'header' && typeof value.name === 'string' && !authHeaderNameProblem(value.name)) {
    return { kind: 'header', name: value.name.trim() };
  }
  return undefined;
}

function readCapabilities(value: unknown): ProviderCapabilities | undefined {
  if (!isRecord(value) || typeof value.probedAt !== 'string') return undefined;
  const flag = (key: string): boolean => value[key] === true;
  return {
    models: flag('models'),
    chat: flag('chat'),
    streaming: flag('streaming'),
    streamUsage: flag('streamUsage'),
    tools: flag('tools'),
    ...(typeof value.model === 'string' && value.model.trim() ? { model: value.model.trim() } : {}),
    probedAt: value.probedAt
  };
}

/**
 * Validates one stored endpoint. Anything malformed returns `undefined` —
 * the caller drops it rather than failing the whole settings load.
 */
export function sanitizeCustomProvider(raw: unknown): CustomProviderConfig | undefined {
  if (!isRecord(raw) || !isCustomProviderId(raw.id)) return undefined;
  if (typeof raw.baseUrl !== 'string' || customBaseUrlProblem(raw.baseUrl)) return undefined;
  const auth = readAuth(raw.auth);
  if (!auth) return undefined;
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 80) : raw.id.slice(CUSTOM_PROVIDER_PREFIX.length);
  const config: CustomProviderConfig = {
    id: raw.id,
    label,
    protocol: 'openai-chat',
    baseUrl: raw.baseUrl.trim().replace(/\/+$/, ''),
    apiPath: typeof raw.apiPath === 'string' ? normalizeApiPath(raw.apiPath) : '',
    auth
  };
  if (typeof raw.presetId === 'string' && /^[a-z0-9-]{1,40}$/.test(raw.presetId)) config.presetId = raw.presetId;
  if (isRecord(raw.headers)) {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw.headers)) {
      if (typeof value === 'string' && !customHeaderNameProblem(name) && !/[\r\n]/.test(value)) headers[name.trim()] = value;
    }
    if (Object.keys(headers).length > 0) config.headers = headers;
  }
  if (Array.isArray(raw.manualModels)) {
    const models = [...new Set(raw.manualModels.filter((m): m is string => typeof m === 'string' && m.trim().length > 0).map(m => m.trim()))];
    if (models.length > 0) config.manualModels = models;
  }
  if (typeof raw.streamUsage === 'boolean') config.streamUsage = raw.streamUsage;
  const capabilities = readCapabilities(raw.capabilities);
  if (capabilities) config.capabilities = capabilities;
  return config;
}

/** Validates the stored list: drops malformed entries and duplicate ids (first wins). */
export function sanitizeCustomProviders(raw: unknown): CustomProviderConfig[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CustomProviderConfig[] = [];
  for (const entry of raw) {
    const config = sanitizeCustomProvider(entry);
    if (!config || seen.has(config.id)) continue;
    seen.add(config.id);
    out.push(config);
  }
  return out;
}
