import * as path from 'node:path';
import { app } from 'electron';
import {
  AcpAgentHost,
  AiSessionManager,
  listCatalogModels,
  getKnownContextLength,
  getModelPricing,
  probeApiKeyAuth,
  probeOpenAiCompatible,
  gatewayOptionsFor,
  getProviderDescriptor,
  isCustomProviderId,
  listProviderIds,
  providerNeedsApiKey,
  sanitizeCustomProvider,
  customBaseUrlProblem,
  customHeaderNameProblem,
  customProviderIdFor,
  clearProviderApiKey,
  storeProviderApiKey,
  type CustomProviderConfig,
  type SaveCustomProviderInput,
  type ProviderProbeResult,
  resolveGatewayUrlFromEnv,
  VercelAgentService,
  getStoredProviderApiKey,
  isExecutableAvailable,
  probeCliProvider,
  type ProviderCapabilityProbe,
  resolveProviderApiKey,
  type AcpAgentLogger,
  type AiKeySource,
  type AiProvider,
  type AiProviderStatus,
  type ModelOptions,
  type PermissionDecision,
  type VercelAgentLogger
} from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';
import { getSecretsStore } from './connectionStoreInstance';
import { getSettingsBackend } from './settingsBackendInstance';
import { getLogBus } from './logBusInstance';

let sessionManager: AiSessionManager | undefined;
let agentService: VercelAgentService | undefined;
let acpAgentHost: AcpAgentHost | undefined;
let analysisStore: JsonKeyValueStore | undefined;

/**
 * Shared AiSessionManager singleton — the same class the VS Code extension
 * uses, backed here by a JSON file under `userData` (honours `--user-data-dir`,
 * so the Playwright suite's throwaway profiles isolate sessions).
 */
export function getAiSessionManager(): AiSessionManager {
  if (!sessionManager) {
    sessionManager = new AiSessionManager(
      new JsonKeyValueStore(path.join(app.getPath('userData'), 'ai-sessions.json'))
    );
  }
  return sessionManager;
}

/**
 * Key-value store holding the per-issue analysis conversations (chat history,
 * confirmation state) — `userData/ai-analysis.json`, same isolation rules as
 * the sessions file.
 */
export function getAiAnalysisStore(): JsonKeyValueStore {
  if (!analysisStore) {
    analysisStore = new JsonKeyValueStore(path.join(app.getPath('userData'), 'ai-analysis.json'));
  }
  return analysisStore;
}

/** Drops file-backed AI singletons after their files are cleared by a reset. */
export function resetAiStores(): void {
  sessionManager = undefined;
  analysisStore = undefined;
  agentService = undefined;
  acpAgentHost = undefined;
}

// Tee into the shared log bus so the Output panel sees agent traffic; the
// console keeps the same `[ai]`-prefixed lines as before.
const mainProcessLogger: VercelAgentLogger & AcpAgentLogger = getLogBus().tee('ai', {
  appendLine: line => console.log(line)
});

/** Shared VercelAgentService singleton — owns the running `kind: 'api'` agent loops in this process. */
export function getVercelAgentService(): VercelAgentService {
  if (!agentService) {
    agentService = new VercelAgentService(getAiSessionManager(), mainProcessLogger);
  }
  return agentService;
}

/** Shared AcpAgentHost singleton — owns every running `hostKind: 'acp'` session (Claude Code, Codex CLI, and GitHub Copilot via `copilot --acp`). */
export function getAcpAgentHost(): AcpAgentHost {
  if (!acpAgentHost) {
    acpAgentHost = new AcpAgentHost(getAiSessionManager(), mainProcessLogger);
  }
  return acpAgentHost;
}

/** Every issue key with a currently-running task, across both agent hosts. */
export function getAllActiveTaskIssueKeys(): string[] {
  return [
    ...new Set([...getVercelAgentService().getActiveTaskIssueKeys(), ...getAcpAgentHost().getActiveTaskIssueKeys()])
  ];
}

/** True when any host currently owns an active task for this issue. */
export function hasActiveTask(issueKey: string): boolean {
  return getVercelAgentService().hasActiveTask(issueKey) || getAcpAgentHost().hasActiveTask(issueKey);
}

/** Aborts the task for this issue on whichever host owns it (no-op if none). */
export async function abortActiveTask(issueKey: string): Promise<void> {
  if (getVercelAgentService().hasActiveTask(issueKey)) {
    await getVercelAgentService().abortTask(issueKey);
  }
  if (getAcpAgentHost().hasActiveTask(issueKey)) {
    await getAcpAgentHost().abortTask(issueKey);
  }
}

/** Resolves the pending permission request for this issue on whichever host owns it (no-op if none). */
export function respondToActivePermission(issueKey: string, decision: PermissionDecision): void {
  if (getVercelAgentService().hasActiveTask(issueKey)) {
    getVercelAgentService().respondToPermission(issueKey, decision);
  }
  if (getAcpAgentHost().hasActiveTask(issueKey)) {
    getAcpAgentHost().respondToPermission(issueKey, decision);
  }
}

/** Resolves the executable + args to spawn for a `hostKind: 'acp'` provider (Claude Code, Codex CLI, or GitHub Copilot via `copilot --acp`). */
export function resolveAcpStartOptions(provider: AiProvider): { command: string; args?: string[] } {
  const descriptor = getProviderDescriptor(provider);
  if (descriptor.kind !== 'cli-agent' || descriptor.hostKind !== 'acp') {
    throw new Error(`${descriptor.label} is not an ACP-hosted provider.`);
  }
  const settings = getSettingsBackend().read();
  const command = settings.ai.providers[provider]?.cliPath?.trim() || descriptor.defaultCommand!;
  return { command, args: descriptor.defaultArgs };
}

/** The available models for a `hostKind: 'acp'` provider, or `undefined` for any other provider/no selector. */
export async function listCliModelOptions(provider: AiProvider): Promise<ModelOptions | undefined> {
  const descriptor = getProviderDescriptor(provider);
  if (descriptor.kind !== 'cli-agent' || descriptor.hostKind !== 'acp') {
    return undefined;
  }
  const { command, args } = resolveAcpStartOptions(provider);
  const settings = getSettingsBackend().read();
  const raw = await getAcpAgentHost().listAvailableModels({
    command,
    args,
    workingDirectory: settings.ai.workingDirectory.trim() || undefined
  });
  if (!raw) {
    return undefined;
  }
  return {
    ...raw,
    options: raw.options.map(opt => {
      const contextLength = opt.contextLength ?? getKnownContextLength(opt.value, provider);
      const pricing = opt.pricing ?? getModelPricing(provider, opt.value);
      return {
        ...opt,
        ...(typeof contextLength === 'number' && contextLength > 0 ? { contextLength } : {}),
        ...(pricing ? { pricing } : {})
      };
    })
  };
}

/**
 * The available models for a `kind: 'api'` provider (Vercel AI Gateway,
 * OpenAI, Anthropic), fetched from its real model-listing endpoint and
 * cached by `listCatalogModels` — `undefined` when no API key is
 * configured or the fetch fails (network error, endpoint not supported).
 */
export async function listApiModelOptions(provider: AiProvider, forceRefresh?: boolean): Promise<ModelOptions | undefined> {
  const descriptor = getProviderDescriptor(provider);
  if (descriptor.kind !== 'api') {
    return undefined;
  }
  const { apiKey, gatewayUrl, model } = await resolveConnectionOptions(provider);
  if (!apiKey && providerNeedsApiKey(provider)) {
    return undefined;
  }
  // vercel-gateway carries a legacy env-var fallback for the URL too
  // (AI_GATEWAY_URL etc. — see resolveGatewayUrlFromEnv's callers), which
  // the real completions path already honors; match it here so the model
  // picker resolves against the same gateway a session would actually use.
  const url = provider === 'vercel-gateway' ? resolveGatewayUrlFromEnv(gatewayUrl) : gatewayUrl || descriptor.defaultBaseUrl;
  try {
    const options = await listCatalogModels(provider, gatewayOptionsFor(provider, url, apiKey), forceRefresh);
    return { currentValue: model, options };
  } catch {
    return undefined;
  }
}

/** Tests whether the configured API key and endpoint for a provider can connect successfully. */
export async function testProviderConnection(provider: AiProvider): Promise<{ ok: boolean; message: string }> {
  const descriptor = getProviderDescriptor(provider);
  if (descriptor.kind !== 'api') {
    return { ok: true, message: `${descriptor.label} is a local CLI agent.` };
  }
  const { apiKey, gatewayUrl, model } = await resolveConnectionOptions(provider);
  if (!apiKey && providerNeedsApiKey(provider)) {
    throw new Error(`No ${descriptor.label} API key configured.`);
  }
  if (descriptor.custom) {
    // A saved endpoint is tested the same way as a draft, and remembers what it found.
    const result = await testCustomProvider(descriptor.custom, { model });
    const failed = result.steps.filter(step => step.status === 'fail');
    if (!result.capabilities.chat) throw new Error(failed[0]?.detail ?? 'The endpoint did not answer a chat request.');
    return {
      ok: true,
      message: failed.length === 0
        ? `Connected to ${descriptor.label} — every check passed.`
        : `Connected to ${descriptor.label}. ${failed.map(step => step.detail).join(' ')}`
    };
  }
  const url = provider === 'vercel-gateway' ? resolveGatewayUrlFromEnv(gatewayUrl) : gatewayUrl || descriptor.defaultBaseUrl;
  const testModel = model || descriptor.defaultModel;

  try {
    if (provider === 'anthropic' || provider === 'gemini') {
      await listCatalogModels(provider, { apiKey, url }, true);
      return { ok: true, message: `Connected successfully to ${descriptor.label}.` };
    }
    // OpenAI, Vercel Gateway, Z.ai
    await probeApiKeyAuth(gatewayOptionsFor(provider, url, apiKey), 10_000, testModel);
    return { ok: true, message: `Connected successfully to ${descriptor.label}.` };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    let friendly = raw;
    try {
      const match = raw.match(/\{.*\}$/s);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (parsed?.error?.message) {
          friendly = `${parsed.error.message}${parsed.error.code ? ` (code ${parsed.error.code})` : ''}`;
        }
      }
    } catch {
      // not JSON
    }
    throw new Error(friendly);
  }
}

/**
 * Runs the capability probe against an endpoint — a saved one, or an unsaved
 * draft from the settings form (`apiKey` is then the typed key, never stored
 * by this call). A draft carrying a saved endpoint's id falls back to that
 * endpoint's stored key when no key is typed. The result is written back to
 * the saved endpoint only when the probe targeted exactly what is saved.
 */
export async function testCustomProvider(
  draft: CustomProviderConfig,
  options: { apiKey?: string; model?: string } = {}
): Promise<ProviderProbeResult> {
  const config = sanitizeCustomProvider(draft);
  if (!config) throw new Error('Check the endpoint URL and authentication.');
  const typedKey = options.apiKey?.trim();
  const apiKey = typedKey || (config.auth.kind === 'none' ? undefined : await resolveProviderApiKey(getSecretsStore(), config.id));
  const result = await probeOpenAiCompatible({
    url: config.baseUrl,
    apiKey,
    apiPath: config.apiPath,
    exactPath: true,
    auth: config.auth,
    ...(config.headers ? { headers: config.headers } : {})
  }, options.model);
  const settings = getSettingsBackend().read();
  const saved = settings.ai.customProviders?.find(provider => provider.id === config.id);
  const sameTarget = saved && saved.baseUrl === config.baseUrl && saved.apiPath === config.apiPath && saved.auth.kind === config.auth.kind && !typedKey;
  if (saved && sameTarget) {
    await getSettingsBackend().write({
      ai: {
        customProviders: (settings.ai.customProviders ?? []).map(provider => provider.id === config.id
          ? { ...provider, capabilities: result.capabilities, streamUsage: result.capabilities.streamUsage || !result.capabilities.streaming ? provider.streamUsage : false }
          : provider)
      }
    });
  }
  return result;
}

/**
 * Agent sessions drive tools on every turn. An endpoint whose connection test
 * showed no tool calling would fail on its first tool use, so it is refused up
 * front with the reason; one that was never tested is allowed (built-ins never
 * carry a probe result).
 */
export function assertCanRunAgentSession(provider: AiProvider): void {
  const descriptor = getProviderDescriptor(provider);
  if (descriptor.kind === 'api' && descriptor.custom?.capabilities && !descriptor.custom.capabilities.tools) {
    throw new Error(`${descriptor.label} didn't pass tool calling, which agent sessions need. Run its connection test in Settings → AI Provider after changing the model or server.`);
  }
}

/** Adds or updates a custom endpoint (and its key), validating it the same way settings load does. */
export async function saveCustomProvider(input: SaveCustomProviderInput): Promise<CustomProviderConfig> {
  const settings = getSettingsBackend().read();
  const existing = settings.ai.customProviders ?? [];
  const requestedId = input.config.id;
  const isUpdate = requestedId !== undefined && existing.some(provider => provider.id === requestedId);
  const id = isUpdate ? requestedId : customProviderIdFor(input.config.label, existing.map(provider => provider.id));
  const urlProblem = customBaseUrlProblem(input.config.baseUrl ?? '');
  if (urlProblem) throw new Error(urlProblem);
  for (const name of Object.keys(input.config.headers ?? {})) {
    const problem = customHeaderNameProblem(name);
    if (problem) throw new Error(problem);
  }
  const config = sanitizeCustomProvider({ ...input.config, id });
  if (!config) throw new Error('Check the endpoint name, URL and authentication.');
  const customProviders = isUpdate
    ? existing.map(provider => (provider.id === id ? config : provider))
    : [...existing, config];
  await getSettingsBackend().write({
    ai: {
      customProviders,
      ...(input.defaultModel !== undefined
        ? { providers: { [id]: { ...(settings.ai.providers[id] ?? {}), defaultModel: input.defaultModel.trim() || undefined } } }
        : {})
    }
  });
  if (config.auth.kind === 'none') {
    await clearProviderApiKey(getSecretsStore(), id);
  } else if (input.apiKey !== undefined) {
    if (input.apiKey.trim()) await storeProviderApiKey(getSecretsStore(), id, input.apiKey);
    else await clearProviderApiKey(getSecretsStore(), id);
  }
  return config;
}

/** Deletes a custom endpoint and its key. Settings that named it fall back (see `mergeAppSettings`). */
export async function removeCustomProvider(id: AiProvider): Promise<void> {
  if (!isCustomProviderId(id)) throw new Error(`“${id}” is a built-in provider and can't be removed.`);
  const settings = getSettingsBackend().read();
  const customProviders = (settings.ai.customProviders ?? []).filter(provider => provider.id !== id);
  await getSettingsBackend().write({ ai: { customProviders } });
  await clearProviderApiKey(getSecretsStore(), id);
}

/** Completes ACP initialize without creating a provider session or sending a prompt. */
export async function probeProviderCapability(provider: AiProvider): Promise<ProviderCapabilityProbe | undefined> {
  const descriptor = getProviderDescriptor(provider);
  if (descriptor.kind !== 'cli-agent') return undefined;
  const { command, args } = resolveAcpStartOptions(provider);
  const preflight = await probeCliProvider(command);
  if (preflight.status !== 'ready') return preflight;
  try {
    const settings = getSettingsBackend().read();
    const capabilities = await getAcpAgentHost().probeCapabilities({
      command,
      args,
      workingDirectory: settings.ai.workingDirectory.trim() || undefined
    });
    return { ...preflight, capabilities };
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
      ...(preflight.providerVersion ? { providerVersion: preflight.providerVersion } : {})
    };
  }
}

/** Effective connection options for starting a task on the given provider: secret-store key
 *  (with env fallback for vercel-gateway), configured URL/model. */
export async function resolveConnectionOptions(provider: AiProvider): Promise<{
  apiKey?: string;
  gatewayUrl?: string;
  model?: string;
}> {
  const settings = getSettingsBackend().read();
  const apiKey = await resolveProviderApiKey(getSecretsStore(), provider);
  if (provider === 'vercel-gateway') {
    return {
      apiKey,
      gatewayUrl: settings.ai.gatewayUrl.trim() || undefined,
      model: settings.ai.defaultModel.trim() || undefined
    };
  }
  const config = settings.ai.providers[provider];
  return {
    apiKey,
    // A custom endpoint's URL lives on the endpoint itself (its descriptor's default).
    gatewayUrl: isCustomProviderId(provider) ? undefined : config?.baseUrl?.trim() || undefined,
    model: config?.defaultModel?.trim() || undefined
  };
}

/** Back-compat wrapper resolving the currently active provider's connection options. */
export async function resolveGatewayOptions(): Promise<{
  apiKey?: string;
  gatewayUrl?: string;
  model?: string;
}> {
  const settings = getSettingsBackend().read();
  return resolveConnectionOptions(settings.ai.activeProvider);
}

/** Status snapshot for one provider — the key value itself never crosses IPC. */
async function buildProviderStatus(provider: AiProvider): Promise<AiProviderStatus> {
  const settings = getSettingsBackend().read();
  const descriptor = getProviderDescriptor(provider);

  if (descriptor.kind === 'cli-agent') {
    // No API key concept — auth is the CLI's own (e.g. `claude login`,
    // `copilot login`), outside this app's purview. "Configured" reflects a
    // real, free, cross-platform check that the command actually resolves to
    // a spawnable executable (no ACP handshake, no LLM call — see
    // `isExecutableAvailable`'s doc comment).
    const cliPathOverride = settings.ai.providers[provider]?.cliPath?.trim();
    const command = cliPathOverride || descriptor.defaultCommand;
    const configured = command ? await isExecutableAvailable(command) : true;
    return {
      provider,
      label: descriptor.label,
      kind: 'cli-agent',
      configured,
      enabled: settings.ai.providers[provider]?.enabled !== false,
      keySource: 'none',
      gatewayUrl: command || 'bundled runtime',
      defaultModel: '',
      agentName: settings.ai.agentName,
      activeTasks: getAcpAgentHost().getActiveTaskIssueKeys()
    };
  }

  const stored = await getStoredProviderApiKey(getSecretsStore(), provider);
  let keySource: AiKeySource = 'none';
  if (stored) {
    keySource = 'secret';
  } else if (await resolveProviderApiKey(getSecretsStore(), provider)) {
    keySource = 'env';
  }
  const config = provider === 'vercel-gateway' ? undefined : settings.ai.providers[provider];
  const gatewayUrl =
    provider === 'vercel-gateway'
      ? settings.ai.gatewayUrl.trim() || descriptor.defaultBaseUrl
      : descriptor.custom
        ? descriptor.defaultBaseUrl
        : config?.baseUrl?.trim() || descriptor.defaultBaseUrl;
  const defaultModel =
    provider === 'vercel-gateway' ? settings.ai.defaultModel : config?.defaultModel ?? '';
  const custom = descriptor.custom;
  return {
    provider,
    label: descriptor.label,
    kind: 'api',
    // A "No key" endpoint (a local runtime) is ready as soon as it exists.
    configured: keySource !== 'none' || !providerNeedsApiKey(provider),
    ...(custom ? { custom: true, needsKey: custom.auth.kind !== 'none', ...(custom.capabilities ? { capabilities: custom.capabilities } : {}) } : {}),
    enabled: settings.ai.providers[provider]?.enabled !== false,
    keySource,
    gatewayUrl,
    defaultModel,
    agentName: settings.ai.agentName,
    activeTasks: getVercelAgentService().getActiveTaskIssueKeys()
  };
}

/** Active provider's status snapshot — kept for callers not yet updated to the multi-provider list. */
export async function getAiProviderStatus(): Promise<AiProviderStatus> {
  const settings = getSettingsBackend().read();
  return buildProviderStatus(settings.ai.activeProvider);
}

/** Every configured provider's status, for the settings UI and the session picker. */
export async function listAiProviderStatuses(): Promise<AiProviderStatus[]> {
  return Promise.all(listProviderIds().map(provider => buildProviderStatus(provider)));
}
