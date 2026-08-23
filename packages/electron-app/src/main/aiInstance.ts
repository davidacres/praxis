import * as path from 'node:path';
import { app } from 'electron';
import {
  AcpAgentHost,
  AiSessionManager,
  PROVIDER_DESCRIPTORS,
  VercelAgentService,
  getStoredProviderApiKey,
  resolveProviderApiKey,
  type AcpAgentLogger,
  type AiKeySource,
  type AiProvider,
  type AiProviderStatus,
  type PermissionDecision,
  type VercelAgentLogger
} from '@ticket-manager/core';
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

/** Shared AcpAgentHost singleton — owns the running `kind: 'cli-agent'` (Claude Code / Codex CLI) sessions. */
export function getAcpAgentHost(): AcpAgentHost {
  if (!acpAgentHost) {
    acpAgentHost = new AcpAgentHost(getAiSessionManager(), mainProcessLogger);
  }
  return acpAgentHost;
}

/** Every issue key with a currently-running task, across both agent hosts. */
export function getAllActiveTaskIssueKeys(): string[] {
  return [...new Set([...getVercelAgentService().getActiveTaskIssueKeys(), ...getAcpAgentHost().getActiveTaskIssueKeys()])];
}

/** True when either host currently owns an active task for this issue. */
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

/** Resolves the executable + args to spawn for a `kind: 'cli-agent'` provider. */
export function resolveAcpStartOptions(provider: AiProvider): { command: string; args?: string[] } {
  const descriptor = PROVIDER_DESCRIPTORS[provider];
  if (descriptor.kind !== 'cli-agent') {
    throw new Error(`${descriptor.label} is not a CLI-hosted provider.`);
  }
  const settings = getSettingsBackend().read();
  const command = settings.ai.providers[provider]?.cliPath?.trim() || descriptor.defaultCommand;
  return { command };
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
    gatewayUrl: config?.baseUrl?.trim() || undefined,
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
  const descriptor = PROVIDER_DESCRIPTORS[provider];

  if (descriptor.kind === 'cli-agent') {
    // No API key concept — auth is the CLI's own (e.g. `claude login`),
    // outside this app's purview. "Configured" just reflects whether a
    // command override/PATH resolution exists to try.
    return {
      provider,
      configured: true,
      keySource: 'none',
      gatewayUrl: settings.ai.providers[provider]?.cliPath?.trim() || descriptor.defaultCommand,
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
      : config?.baseUrl?.trim() || descriptor.defaultBaseUrl;
  const defaultModel =
    provider === 'vercel-gateway' ? settings.ai.defaultModel : config?.defaultModel ?? '';
  return {
    provider,
    configured: keySource !== 'none',
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
  return Promise.all(
    (Object.keys(PROVIDER_DESCRIPTORS) as AiProvider[]).map(provider => buildProviderStatus(provider))
  );
}
