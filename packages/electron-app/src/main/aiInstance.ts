import * as path from 'node:path';
import { app } from 'electron';
import {
  AiSessionManager,
  SECRET_VERCEL_API_KEY,
  VercelAgentService,
  defaultGatewayUrl,
  resolveGatewayApiKeyFromEnv,
  resolveVercelApiKey,
  type AiKeySource,
  type AiProviderStatus,
  type VercelAgentLogger
} from '@ticket-manager/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';
import { getSecretsStore } from './connectionStoreInstance';
import { getSettingsBackend } from './settingsBackendInstance';
import { getLogBus } from './logBusInstance';

let sessionManager: AiSessionManager | undefined;
let agentService: VercelAgentService | undefined;
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
const mainProcessLogger: VercelAgentLogger = getLogBus().tee('ai', {
  appendLine: line => console.log(line)
});

/** Shared VercelAgentService singleton — owns the running agent loops in this process. */
export function getVercelAgentService(): VercelAgentService {
  if (!agentService) {
    agentService = new VercelAgentService(getAiSessionManager(), mainProcessLogger);
  }
  return agentService;
}

/** Effective gateway options for starting a task: secret-store key, env fallback, configured URL/model. */
export async function resolveGatewayOptions(): Promise<{
  apiKey?: string;
  gatewayUrl?: string;
  model?: string;
}> {
  const settings = getSettingsBackend().read();
  const apiKey = await resolveVercelApiKey(getSecretsStore());
  return {
    apiKey,
    gatewayUrl: settings.ai.gatewayUrl.trim() || undefined,
    model: settings.ai.defaultModel.trim() || undefined
  };
}

/** Provider snapshot for the settings UI — the key value itself never crosses IPC. */
export async function getAiProviderStatus(): Promise<AiProviderStatus> {
  const settings = getSettingsBackend().read();
  const stored = await getSecretsStore().get(SECRET_VERCEL_API_KEY);
  const keySource: AiKeySource = stored?.trim()
    ? 'secret'
    : resolveGatewayApiKeyFromEnv()
      ? 'env'
      : 'none';
  return {
    provider: 'vercel-gateway',
    configured: keySource !== 'none',
    keySource,
    gatewayUrl: settings.ai.gatewayUrl.trim() || defaultGatewayUrl(),
    defaultModel: settings.ai.defaultModel,
    agentName: settings.ai.agentName,
    activeTasks: getVercelAgentService().getActiveTaskIssueKeys()
  };
}
