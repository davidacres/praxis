import * as vscode from 'vscode';
import type { SecretsStore } from '@praxis/core';
import type {
  AiAgentRegistration,
  AiProvider,
  BackendMode,
  ConnectionType,
  DeliveryWorkflowSettings,
  SecretConnectionValues
} from '@praxis/core';
import { VsCodeSecretsStore } from '../adapters/vsCodeSecretsStore';
import {
  clearVercelApiKey,
  migrateVercelCredentialToSecretStorage,
  resolveVercelApiKey,
  storeVercelApiKey
} from '@praxis/core';
import { resolveGatewayApiKeyFromEnv, resolveGatewayUrlFromEnv } from '@praxis/core';
import {
  buildAiProviderSettingsFromLegacy,
  isNestedAiProviderObject,
  isAiProviderConfigured,
  LEGACY_AI_SETTING_KEYS,
  legacyAiSettingsHaveValues,
  readFlatAiProviderSettings,
  sanitizeAiProviderSettings,
  type AiProviderSettings,
  type LegacyAiSettingsSnapshot
} from './aiProviderConfig';

const CONFIG_ROOT = 'ticketManager';
const SECRET_ENV_KEY = 'ticketManager.secretEnv';
const SECRET_HEADERS_KEY = 'ticketManager.secretHeaders';

const DEFAULT_JIRA_BASE_URL = 'https://jira.example.com';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string');
}

function formatJson(value: Record<string, string> | string[]): string {
  return JSON.stringify(value, null, 2);
}

function parseJsonObject(input: string, label: string): Record<string, string> {
  if (input.trim().length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new Error(`Invalid ${label}: ${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`${label} values must be strings.`);
    }

    result[key] = value;
  }

  return result;
}

function parseJsonArray(input: string, label: string): string[] {
  if (input.trim().length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new Error(`Invalid ${label}: ${(error as Error).message}`);
  }

  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
    throw new Error(`${label} must be a JSON array of strings.`);
  }

  return parsed;
}

export class AppConfigStore {
  private secrets: SecretsStore | undefined;
  /** Cached Vercel gateway API key from SecretStorage / migration / env. */
  private vercelApiKeyCache = '';

  /** Bind extension SecretStorage so gateway keys are not kept in settings.json. */
  public bindExtensionSecrets(secrets: vscode.SecretStorage): void {
    this.secrets = new VsCodeSecretsStore(secrets);
  }

  /**
   * Refresh the in-memory Vercel API key cache and migrate any legacy
   * `ai.credential` value into SecretStorage.
   */
  public async refreshVercelApiKeyCache(): Promise<void> {
    if (!this.secrets) {
      this.vercelApiKeyCache = resolveGatewayApiKeyFromEnv() || '';
      return;
    }

    const settings = this.getAiProviderSettings();
    if (settings.provider === 'vercel-gateway' && settings.credential.trim()) {
      const migrated = await migrateVercelCredentialToSecretStorage(
        this.secrets,
        settings.credential
      );
      if (migrated.migrated) {
        await this.setAiProviderSettings({
          ...settings,
          credential: ''
        });
      }
    }

    const resolved = await resolveVercelApiKey(this.secrets, settings.credential);
    this.vercelApiKeyCache = resolved ?? '';
  }

  public async storeVercelGatewayApiKey(apiKey: string): Promise<void> {
    if (!this.secrets) {
      throw new Error('SecretStorage is not available.');
    }
    await storeVercelApiKey(this.secrets, apiKey);
    this.vercelApiKeyCache = apiKey.trim();
  }

  public async clearVercelGatewayApiKey(): Promise<void> {
    if (!this.secrets) {
      return;
    }
    await clearVercelApiKey(this.secrets);
    this.vercelApiKeyCache = '';
  }

  public hasVercelGatewayApiKeyCached(): boolean {
    return this.vercelApiKeyCache.trim().length > 0;
  }

  public async getSecretValues(context: vscode.ExtensionContext): Promise<SecretConnectionValues> {
    const [storedEnv, storedHeaders] = await Promise.all([
      context.secrets.get(SECRET_ENV_KEY),
      context.secrets.get(SECRET_HEADERS_KEY)
    ]);

    return {
      env: storedEnv ? parseJsonObject(storedEnv, 'stored environment') : {},
      headers: storedHeaders ? parseJsonObject(storedHeaders, 'stored headers') : {}
    };
  }

  public getConnectionType(): ConnectionType {
    return vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .get<ConnectionType>('connectionType', 'stdio');
  }

  public getBackendMode(): BackendMode | undefined {
    return this.getWorkspaceScopedConfigValue<BackendMode>('backendMode');
  }

  public getEffectiveBackendMode(): BackendMode {
    return this.getBackendMode() ?? 'jiracloud';
  }

  public hasJiraConnectionConfig(): boolean {
    const config = vscode.workspace.getConfiguration(CONFIG_ROOT);
    const connectionType = config.get<ConnectionType>('connectionType', 'stdio');
    if (connectionType === 'http') {
      return config.get<string>('httpUrl', '').trim().length > 0;
    }

    return config.get<string>('stdioCommand', '').trim().length > 0;
  }

  public async setBackendMode(mode: BackendMode): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace.getConfiguration(CONFIG_ROOT).update('backendMode', mode, target);
  }

  public getRequestTimeoutMs(): number {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<number>('requestTimeoutMs', 30000);
  }

  public getDefaultPageSize(): number {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<number>('defaultPageSize', 25);
  }

  public getDeliveryDefaultBaseBranch(): string | undefined {
    const value = vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('delivery.defaultBaseBranch', '');
    return value.trim() || undefined;
  }

  public isAutoMergeSubTasksEnabled(): boolean {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<boolean>('delivery.autoMergeSubTasks', true);
  }

  /**
   * Returns an optional default project key from `jiraMcp.defaultProjectKey`
   * if it has been configured. Empty string otherwise.
   */
  public getJiraDefaultProjectKey(): string {
    return this.getWorkspaceScopedConfigValue<string>('jiraMcp.defaultProjectKey', '').trim();
  }

  public getJiraDefaultBaseUrl(): string {
    return DEFAULT_JIRA_BASE_URL;
  }

  // ── Jira MCP ──────────────────────────────────────────────────────

  public getJiraMcpSiteUrl(): string {
    return this.getWorkspaceScopedConfigValue<string>('jiraMcpSiteUrl', '').trim();
  }

  public async setJiraMcpSiteUrl(value: string | undefined): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .update('jiraMcpSiteUrl', value?.trim() ?? '', target);
  }

  public getJiraMcpEpicKey(): string {
    return this.getWorkspaceScopedConfigValue<string>('jiraMcpEpicKey', '').trim();
  }

  public getJiraMcpEpicBoardName(): string {
    return this.getWorkspaceScopedConfigValue<string>('jiraMcpEpicBoardName', '').trim();
  }

  public getJiraMcpBoardJql(): string {
    return this.getWorkspaceScopedConfigValue<string>('jiraMcpBoardJql', '').trim();
  }

  public getJiraMcpBoardName(): string {
    return this.getWorkspaceScopedConfigValue<string>('jiraMcpBoardName', '').trim();
  }

  public async setJiraMcpEpicKey(value: string | undefined): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .update('jiraMcpEpicKey', value?.trim() ?? '', target);
  }

  public async setJiraMcpEpicBoardName(value: string | undefined): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .update('jiraMcpEpicBoardName', value?.trim() ?? '', target);
  }

  public async setJiraMcpBoardJql(value: string | undefined): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .update('jiraMcpBoardJql', value?.trim() ?? '', target);
  }

  public async setJiraMcpBoardName(value: string | undefined): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .update('jiraMcpBoardName', value?.trim() ?? '', target);
  }

  /**
   * Indicates whether a Jira MCP connection can be established. Defers to the
   * `JiraMcpConnectionResolver` when available, otherwise falls back to a
   * direct check against the legacy stdio/http settings.
   */
  public async hasJiraMcpConfigPublic(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration(CONFIG_ROOT);

    const connectionType = config.get<ConnectionType>('connectionType', 'stdio');
    if (connectionType === 'http') {
      if (config.get<string>('httpUrl', '').trim().length > 0) {
        return true;
      }
    } else if (config.get<string>('stdioCommand', '').trim().length > 0) {
      return true;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const { parse: parseJsonc } = await import('jsonc-parser');
      const mcpPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'mcp.json');
      try {
        const text = await fs.readFile(mcpPath, 'utf8');
        const obj = parseJsonc(text, [], { allowTrailingComma: true }) as
          | { servers?: Record<string, unknown>; mcpServers?: Record<string, unknown> }
          | null;
        const servers = obj?.servers ?? obj?.mcpServers;
        if (servers && typeof servers === 'object') {
          for (const [name, raw] of Object.entries(servers)) {
            if (!isRecord(raw) || typeof raw.command !== 'string') {
              continue;
            }
            if (name.toLowerCase().includes('jira')) {
              return true;
            }
          }
        }
      } catch {
        // ignore
      }
    }

    const homeMcpPath: string = (() => {
      const override = process.env['JIRA_MINI_USER_MCP_PATHS'];
      if (override && override.trim().length > 0) {
        return override.trim();
      }
      const path = require('node:path') as typeof import('node:path');
      const os = require('node:os') as typeof import('node:os');
      return path.join(os.homedir(), '.vscode', 'mcp.json');
    })();
    try {
      const fs = await import('node:fs/promises');
      const { parse: parseJsonc } = await import('jsonc-parser');
      const text = await fs.readFile(homeMcpPath, 'utf8');
      const obj = parseJsonc(text, [], { allowTrailingComma: true }) as
        | { servers?: Record<string, unknown>; mcpServers?: Record<string, unknown> }
        | null;
      const servers = obj?.servers ?? obj?.mcpServers;
      if (servers && typeof servers === 'object') {
        for (const [name, raw] of Object.entries(servers)) {
          if (!isRecord(raw) || typeof raw.command !== 'string') {
            continue;
          }
          if (name.toLowerCase().includes('jira')) {
            return true;
          }
        }
      }
    } catch {
      // ignore
    }

    return false;
  }

  // ── GitHub settings ──────────────────────────────────────────────

  public getGitHubPat(): string {
    return '';
  }

  public getGitHubUrl(): string {
    return '';
  }

  public getGitHubOwner(): string {
    return '';
  }

  // ── GitLab settings ──────────────────────────────────────────────

  public getGitLabUrl(): string {
    return '';
  }

  public async getGitLabApiKeyFromSecrets(context: vscode.ExtensionContext): Promise<string> {
    return (await context.secrets.get('ticketManager.gitlabApiKey') ?? '').trim();
  }

  public getGitLabApiKey(): string {
    return '';
  }

  public async storeGitLabApiKey(context: vscode.ExtensionContext, value: string): Promise<void> {
    await context.secrets.store('ticketManager.gitlabApiKey', value);
  }

  public async deleteGitLabApiKeySecret(context: vscode.ExtensionContext): Promise<void> {
    await context.secrets.delete('ticketManager.gitlabApiKey');
  }

  public getGitLabProjectPath(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('gitlabProjectPath', '');
  }

  public getGitLabListAllAccessibleBoards(): boolean {
    return vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .get<boolean>('gitlabListAllAccessibleBoards', false);
  }

  public getGitLabSelectedBoardRefs(): string[] {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string[]>('gitlabSelectedBoardRefs', []);
  }

  public async setGitLabSelectedBoardRefs(values: string[]): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .update('gitlabSelectedBoardRefs', values, target);
  }

  // ── Live Folder settings ──────────────────────────────────────────

  public getLiveFolderPath(): string {
    return this.getWorkspaceScopedConfigValue<string>('liveFolderPath', '').trim();
  }

  public getLiveFolderProjectKey(): string {
    return this.getWorkspaceScopedConfigValue<string>('liveFolderProjectKey', '').trim();
  }

  public getLiveFolderProjectName(): string {
    return this.getWorkspaceScopedConfigValue<string>('liveFolderProjectName', '').trim();
  }

  public getLiveFolderAllowIssueCreation(): boolean {
    return this.getWorkspaceScopedConfigValue<boolean>('liveFolderAllowIssueCreation', true);
  }

  public async setLiveFolderPath(value: string): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace.getConfiguration(CONFIG_ROOT).update('liveFolderPath', value, target);
  }

  public async setLiveFolderProjectKey(value: string): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace.getConfiguration(CONFIG_ROOT).update('liveFolderProjectKey', value, target);
  }

  public async setLiveFolderProjectName(value: string): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace.getConfiguration(CONFIG_ROOT).update('liveFolderProjectName', value, target);
  }

  // ── AI settings ─────────────────────────────────────────────────

  public getAiProviderSettings(): AiProviderSettings {
    return readFlatAiProviderSettings(vscode.workspace.getConfiguration(CONFIG_ROOT));
  }

  public async setAiProviderSettings(settings: AiProviderSettings): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_ROOT);
    const target = vscode.ConfigurationTarget.Global;
    const normalized = sanitizeAiProviderSettings(settings);
    // Never persist the Vercel API key in settings.json — SecretStorage owns it.
    const credential =
      normalized.provider === 'vercel-gateway' ? '' : normalized.credential;

    await Promise.all([
      config.update('ai.provider', normalized.provider, target),
      config.update('ai.credential', credential, target),
      config.update('ai.agentName', normalized.agentName, target),
      config.update('ai.runtimePath', normalized.runtimePath, target),
      config.update('ai.vercelUrl', normalized.vercelUrl, target)
    ]);
    await this.clearLegacyAiSettings();
  }

  private readLegacyAiSettingsSnapshot(): LegacyAiSettingsSnapshot {
    const config = vscode.workspace.getConfiguration(CONFIG_ROOT);
    return {
      defaultProvider: config.get<AiProvider | 'none'>('ai.defaultProvider', 'none'),
      openaiApiKey: config.get<string>('ai.openaiApiKey', '').trim(),
      claudeApiKey: config.get<string>('ai.claudeApiKey', '').trim(),
      cursorCliPath: config.get<string>('ai.cursorCliPath', '').trim(),
      copilotEnabled: config.get<boolean>('ai.copilotEnabled', false),
      copilotCliPath: config.get<string>('ai.copilotCliPath', '').trim(),
      copilotAgentName: config.get<string>('ai.copilotAgentName', '').trim(),
      claudeCliPath: config.get<string>('ai.claudeCliPath', '').trim(),
      openaiAgentName: config.get<string>('ai.openaiAgentName', '').trim(),
      claudeAgentName: config.get<string>('ai.claudeAgentName', '').trim()
    };
  }

  private hasLegacyAiSettings(): boolean {
    return legacyAiSettingsHaveValues(this.readLegacyAiSettingsSnapshot());
  }

  private async clearLegacyAiSettings(): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_ROOT);
    const target = vscode.ConfigurationTarget.Global;
    await Promise.all(
      LEGACY_AI_SETTING_KEYS.map(async key => {
        try {
          await config.update(key, undefined, target);
        } catch {
          // Legacy keys may already be removed from package.json while still present on disk.
        }
      })
    );
  }

  /** Migrate legacy AI settings into flat ticketManager.ai.* fields. */
  public async migrateAiProviderSettings(): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_ROOT);
    const target = vscode.ConfigurationTarget.Global;
    const current = this.getAiProviderSettings();
    const legacy = this.readLegacyAiSettingsSnapshot();
    const rawProvider = config.get<unknown>('ai.provider');
    const needsObjectMigration = isNestedAiProviderObject(rawProvider);

    if (!this.hasLegacyAiSettings() && !needsObjectMigration) {
      return;
    }

    const migrated =
      current.provider !== 'none' && isAiProviderConfigured(current)
        ? current
        : buildAiProviderSettingsFromLegacy(legacy) ?? current;

    const normalized = sanitizeAiProviderSettings(migrated);
    await Promise.all([
      config.update('ai.provider', normalized.provider, target),
      config.update('ai.credential', normalized.credential, target),
      config.update('ai.agentName', normalized.agentName, target),
      config.update('ai.runtimePath', normalized.runtimePath, target),
      config.update('ai.vercelUrl', normalized.vercelUrl, target)
    ]);
    await this.clearLegacyAiSettings();
  }

  /** @deprecated OpenAI is no longer a supported provider. */
  public getAiOpenaiApiKey(): string {
    return '';
  }

  /** @deprecated Claude API is no longer a supported provider. */
  public getAiClaudeApiKey(): string {
    return '';
  }

  /** @deprecated Cursor CLI is no longer a supported provider. */
  public getAiCursorCliPath(): string {
    return '';
  }

  public getAiVercelGatewayApiKey(): string {
    const settings = this.getAiProviderSettings();
    if (settings.provider !== 'vercel-gateway') {
      return '';
    }
    return this.vercelApiKeyCache || settings.credential || resolveGatewayApiKeyFromEnv() || '';
  }

  public getAiVercelGatewayUrl(): string {
    const settings = this.getAiProviderSettings();
    return resolveGatewayUrlFromEnv(settings.vercelUrl);
  }

  public getAiVercelAgentName(): string {
    const settings = this.getAiProviderSettings();
    return settings.provider === 'vercel-gateway' ? settings.agentName : '';
  }

  /** @deprecated Use getAiVercelGatewayApiKey / getAiVercelAgentName. */
  public getAiCopilotCliPath(): string {
    return '';
  }

  /** @deprecated Use getAiVercelAgentName. */
  public getAiCopilotAgentName(): string {
    return this.getAiVercelAgentName();
  }

  /** @deprecated Claude Code CLI is no longer a supported provider. */
  public getAiClaudeCliPath(): string {
    return '';
  }

  /** @deprecated Use active provider === vercel-gateway. */
  public getAiCopilotEnabled(): boolean {
    return this.getAiProviderSettings().provider === 'vercel-gateway';
  }

  public getAiDefaultProvider(): AiProvider | 'none' {
    return this.getActiveAiProvider();
  }

  /** The single AI provider Ticket Manager uses for assignment, analysis, and agent tasks. */
  public getActiveAiProvider(): AiProvider | 'none' {
    return this.getAiProviderSettings().provider;
  }

  public isProviderCredentialsConfigured(provider: AiProvider): boolean {
    const settings = this.getAiProviderSettings();
    if (settings.provider !== provider) {
      return false;
    }
    return isAiProviderConfigured(settings, {
      secretCredentialPresent: this.hasVercelGatewayApiKeyCached()
    });
  }

  public getAiDefaultModel(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('ai.defaultModel', '');
  }

  public getAiAnalysisEnabled(): boolean {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<boolean>('ai.analysisEnabled', false);
  }

  public getAiAnalysisDefaultPrompt(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('ai.analysisDefaultPrompt', '');
  }

  public getAiAnalysisDefaultModel(): string {
    const configured = vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .get<string>('ai.analysisDefaultModel', '')
      .trim();
    if (configured.length > 0) {
      return configured;
    }
    return this.getAiDefaultModel().trim();
  }

  public isAiAnalysisGateEnabled(): boolean {
    return this.getAiAnalysisEnabled() && this.getAiAnalysisDefaultPrompt().trim().length > 0;
  }

  /** @deprecated OpenAI is no longer a supported provider. */
  public getAiOpenaiAgentName(): string {
    return '';
  }

  /** @deprecated Claude API is no longer a supported provider. */
  public getAiClaudeAgentName(): string {
    return '';
  }

  public getAiMentionName(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('ai.mentionName', '');
  }

  public getAiDeliveryWorkflowSettings(): DeliveryWorkflowSettings {
    const config = vscode.workspace.getConfiguration(CONFIG_ROOT);
    return {
      enabled: config.get<boolean>('ai.deliveryWorkflowEnabled', true),
      publishCommand: config.get<string>('ai.deliveryPublishCommand', '').trim(),
      artifactPattern: config.get<string>('ai.deliveryArtifactPattern', '').trim(),
      agentWorkflowPath: config.get<string>('ai.deliveryAgentWorkflowPath', '').trim() || undefined,
      agentWorkflowUrl: config.get<string>('ai.deliveryAgentWorkflowUrl', '').trim() || undefined,
      summaryTemplate: config.get<string>('ai.deliverySummaryTemplate', '').trim() || undefined,
      failureTemplate: config.get<string>('ai.deliveryFailureTemplate', '').trim() || undefined
    };
  }

  public getConfiguredAiProviders(): AiProvider[] {
    const settings = this.getAiProviderSettings();
    if (
      settings.provider === 'none' ||
      !isAiProviderConfigured(settings, {
        secretCredentialPresent: this.hasVercelGatewayApiKeyCached()
      })
    ) {
      return [];
    }
    return [settings.provider];
  }

  /** Returns the active API-backed agent when credential is configured. */
  public getConfiguredAiAgents(): AiAgentRegistration[] {
    const settings = this.getAiProviderSettings();
    if (settings.provider === 'vercel-gateway' && this.getAiVercelGatewayApiKey()) {
      return [{
        name: settings.agentName.trim() || 'Vercel AI Gateway',
        provider: 'vercel-gateway',
        apiKey: this.getAiVercelGatewayApiKey()
      }];
    }
    return [];
  }

  /** Returns display names for all AI providers that have an API key configured. */
  public getAiAgentNames(): string[] {
    return this.getConfiguredAiAgents().map(a => a.name);
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private configTarget(): vscode.ConfigurationTarget {
    return vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  }

  private getWorkspaceScopedConfigValue<T>(key: string, defaultValue?: T): T {
    const config = vscode.workspace.getConfiguration(CONFIG_ROOT);
    const inspected = config.inspect<T>(key);
    if (vscode.workspace.workspaceFolders?.length) {
      if (inspected?.workspaceFolderValue !== undefined) {
        return inspected.workspaceFolderValue;
      }
      if (inspected?.workspaceValue !== undefined) {
        return inspected.workspaceValue;
      }
      return defaultValue as T;
    }
    if (inspected?.globalValue !== undefined) {
      return inspected.globalValue;
    }
    if (inspected?.defaultValue !== undefined) {
      return inspected.defaultValue;
    }
    return defaultValue as T;
  }

  public async describeConnection(context: vscode.ExtensionContext): Promise<string> {
    if (this.getEffectiveBackendMode() === 'demo') {
      return 'Demo mode';
    }

    if (this.getEffectiveBackendMode() === 'gitlab') {
      return 'GitLab';
    }

    if (this.getEffectiveBackendMode() === 'github') {
      return 'GitHub';
    }

    if (this.getEffectiveBackendMode() === 'livefolder') {
      const folderPath = this.getLiveFolderPath();
      return folderPath ? `Live Folder (${folderPath})` : 'Live Folder (not configured)';
    }

    if (this.getEffectiveBackendMode() === 'userworkspace') {
      return 'User Workspace';
    }

    if (this.getEffectiveBackendMode() === 'jiracloud') {
      const siteUrl = this.getJiraMcpSiteUrl();
      const epicKey = this.getJiraMcpEpicKey();
      const boardJql = this.getJiraMcpBoardJql();
      return siteUrl
        ? `Jira MCP (${siteUrl}${epicKey ? `; epic ${epicKey}` : ''}${boardJql ? '; jql board configured' : ''})`
        : 'Jira MCP (not configured)';
    }

    return 'Not configured';
  }

}
