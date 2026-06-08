import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parse as parseJsonc } from 'jsonc-parser';
import type {
  AiAgentRegistration,
  AiProvider,
  BackendMode,
  ConfigureConnectionResult,
  ConnectionType,
  DeliveryWorkflowSettings,
  SecretConnectionValues
} from '../types';

const CONFIG_ROOT = 'ticketManager';
const SECRET_ENV_KEY = 'ticketManager.secretEnv';
const SECRET_HEADERS_KEY = 'ticketManager.secretHeaders';
const POLLING_CONFIG_PATH = path.resolve(__dirname, '..', '..', 'JiraPollingService', 'appsettings.json');

interface JiraPollingDefaults {
  baseUrl: string;
  token: string;
  projectKey: string;
  rapidViewId?: number;
  internalDns: string;
  preferredResolveIp: string;
}

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

let cachedJiraPollingDefaults: JiraPollingDefaults | undefined;

function loadJiraPollingDefaults(): JiraPollingDefaults {
  if (cachedJiraPollingDefaults) {
    return cachedJiraPollingDefaults;
  }

  const fallback: JiraPollingDefaults = {
    baseUrl: 'https://jira.example.com',
    token: '',
    projectKey: 'KAMAI',
    rapidViewId: 9402,
    internalDns: 'internal-Atlassian-Prod-LB-Jira-Internal-195841951.eu-west-1.elb.amazonaws.com',
    preferredResolveIp: ''
  };

  try {
    const rawText = fs.readFileSync(POLLING_CONFIG_PATH, 'utf8');
    const parsed = parseJsonc(rawText);
    const jiraPolling = isRecord(parsed) && isRecord(parsed.JiraPolling) ? parsed.JiraPolling : {};
    cachedJiraPollingDefaults = {
      baseUrl: asString(jiraPolling.BaseUrl)?.trim() || fallback.baseUrl,
      token: asString(jiraPolling.Token)?.trim() || fallback.token,
      projectKey: asString(jiraPolling.ProjectKey)?.trim() || fallback.projectKey,
      internalDns: asString(jiraPolling.InternalDns)?.trim() || fallback.internalDns,
      preferredResolveIp:
        asString(jiraPolling.PreferredResolveIp)?.trim() || fallback.preferredResolveIp,
      rapidViewId:
        typeof jiraPolling.RapidViewId === 'number' && Number.isInteger(jiraPolling.RapidViewId)
          ? jiraPolling.RapidViewId
          : fallback.rapidViewId
    };
  } catch {
    cachedJiraPollingDefaults = fallback;
  }

  return cachedJiraPollingDefaults;
}

export class AppConfigStore {
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

  public hasJiraCloudConfig(): boolean {
    if (this.getJiraCloudId().length > 0) {
      return true;
    }
    return (
      this.getJiraCloudBaseUrl().trim().length > 0 &&
      this.getJiraCloudToken().trim().length > 0
    );
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

  public getJiraCloudId(): string {
    const config = vscode.workspace.getConfiguration(CONFIG_ROOT);
    return config.get<string>('jiraCloudId', '').trim();
  }

  public getJiraCloudSiteUrl(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('jiraCloudSiteUrl', '').trim();
  }

  public getJiraOAuthClientId(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('jiraOAuthClientId', '').trim();
  }

  public async setJiraOAuthClientId(value: string): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace.getConfiguration(CONFIG_ROOT).update('jiraOAuthClientId', value.trim(), target);
  }

  public getJiraOAuthClientSecret(): string {
    return '';
  }

  public getJiraOAuthScopes(): string[] {
    const requiredScopes = [
      'offline_access',
      'read:jira-work',
      'write:jira-work',
      'read:jira-user',
      'read:me',
      'read:board-scope:jira-software',
      'read:project:jira',
      'read:issue-details:jira'
    ];

    const configured = vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .get<string[]>('jiraOAuthScopes', [])
      .map(scope => scope.trim())
      .filter(scope => scope.length > 0);
    if (configured.length > 0) {
      const merged = new Set(configured);
      for (const scope of requiredScopes) {
        merged.add(scope);
      }
      return [...merged];
    }

    return requiredScopes;
  }

  public async setJiraCloudSite(
    site:
      | {
          id: string;
          name: string;
          url: string;
        }
      | undefined
  ): Promise<void> {
    const target = this.configTarget();
    const config = vscode.workspace.getConfiguration(CONFIG_ROOT);
    const cloudId = site?.id.trim() ?? '';
    const cloudName = site?.name.trim() ?? '';
    const cloudUrl = site?.url.trim() ?? '';

    await Promise.all([
      config.update('jiraCloudId', cloudId, target),
      config.update('jiraCloudSiteName', cloudName, target),
      config.update('jiraCloudSiteUrl', cloudUrl, target)
    ]);
  }

  public isJiraStartupPollingEnabled(): boolean {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<boolean>('jiraPolling.enabled', false);
  }

  public getJiraPollingRequiredLabel(): string {
    const value = this.getWorkspaceScopedConfigValue<string>('jiraPolling.requiredLabel', 'syscfg');
    return value.trim() || 'syscfg';
  }

  public isJiraPollingClarificationAnalysisEnabled(): boolean {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<boolean>('jiraPolling.clarificationAnalysis', false);
  }

  public getDeliveryDefaultBaseBranch(): string | undefined {
    const value = vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('delivery.defaultBaseBranch', '');
    return value.trim() || undefined;
  }

  public isAutoMergeSubTasksEnabled(): boolean {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<boolean>('delivery.autoMergeSubTasks', true);
  }

  public getJiraPollingProjectKey(): string {
    return loadJiraPollingDefaults().projectKey;
  }

  public getJiraPollingRapidViewId(): number | undefined {
    return loadJiraPollingDefaults().rapidViewId;
  }

  public getJiraDefaultBaseUrl(): string {
    return loadJiraPollingDefaults().baseUrl;
  }

  public getJiraCloudInternalDns(): string {
    return loadJiraPollingDefaults().internalDns;
  }

  public getJiraCloudPreferredResolveIp(): string {
    return loadJiraPollingDefaults().preferredResolveIp;
  }

  public getJiraCloudBaseUrl(): string {
    const configured = this.getWorkspaceScopedConfigValue<string>('jiraCloudBaseUrl', '').trim();
    return configured || loadJiraPollingDefaults().baseUrl;
  }

  public getJiraCloudToken(): string {
    const configured = this.getWorkspaceScopedConfigValue<string>('jiraCloudToken', '').trim();
    return configured || process.env.JIRA_TOKEN?.trim() || loadJiraPollingDefaults().token;
  }

  public getJiraCloudEpicKey(): string {
    return this.getWorkspaceScopedConfigValue<string>('jiraCloudEpicKey', '').trim();
  }

  public getJiraCloudEpicBoardName(): string {
    return this.getWorkspaceScopedConfigValue<string>('jiraCloudEpicBoardName', '').trim();
  }

  public getJiraCloudBoardJql(): string {
    return this.getWorkspaceScopedConfigValue<string>('jiraCloudBoardJql', '').trim();
  }

  public getJiraCloudBoardName(): string {
    return this.getWorkspaceScopedConfigValue<string>('jiraCloudBoardName', '').trim();
  }

  public async setJiraCloudEpicKey(value: string | undefined): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .update('jiraCloudEpicKey', value?.trim() ?? '', target);
  }

  public async setJiraCloudEpicBoardName(value: string | undefined): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .update('jiraCloudEpicBoardName', value?.trim() ?? '', target);
  }

  public async setJiraCloudBoardJql(value: string | undefined): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .update('jiraCloudBoardJql', value?.trim() ?? '', target);
  }

  public async setJiraCloudBoardName(value: string | undefined): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .update('jiraCloudBoardName', value?.trim() ?? '', target);
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

  public getAiOpenaiApiKey(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('ai.openaiApiKey', '');
  }

  public getAiClaudeApiKey(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('ai.claudeApiKey', '');
  }

  public getAiCursorCliPath(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('ai.cursorCliPath', '');
  }

  public getAiCopilotCliPath(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('ai.copilotCliPath', '');
  }

  public getAiCopilotAgentName(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('ai.copilotAgentName', '');
  }

  public getAiClaudeCliPath(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('ai.claudeCliPath', '');
  }

  public getAiCopilotEnabled(): boolean {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<boolean>('ai.copilotEnabled', false);
  }

  public getAiDefaultProvider(): AiProvider | 'none' {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<AiProvider | 'none'>('ai.defaultProvider', 'none');
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

  public getAiOpenaiAgentName(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('ai.openaiAgentName', '');
  }

  public getAiClaudeAgentName(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('ai.claudeAgentName', '');
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
    const providers: AiProvider[] = [];
    if (this.getAiOpenaiApiKey().trim().length > 0) {
      providers.push('openai');
    }
    if (this.getAiClaudeApiKey().trim().length > 0) {
      providers.push('claude');
    }
    if (this.getAiCursorCliPath().trim().length > 0) {
      providers.push('cursor-cli');
    }
    if (this.getAiCopilotEnabled() || this.getAiCopilotCliPath().trim().length > 0) {
      providers.push('copilot-cli');
    }
    if (this.getAiClaudeCliPath().trim().length > 0) {
      providers.push('claude-cli');
    }
    return providers;
  }

  /** Returns registered AI agents that have both a name and an API key configured. */
  public getConfiguredAiAgents(): AiAgentRegistration[] {
    const agents: AiAgentRegistration[] = [];
    const openaiKey = this.getAiOpenaiApiKey().trim();
    const openaiName = this.getAiOpenaiAgentName().trim();
    if (openaiName && openaiKey) {
      agents.push({ name: openaiName, provider: 'openai', apiKey: openaiKey });
    }
    const claudeKey = this.getAiClaudeApiKey().trim();
    const claudeName = this.getAiClaudeAgentName().trim();
    if (claudeName && claudeKey) {
      agents.push({ name: claudeName, provider: 'claude', apiKey: claudeKey });
    }
    return agents;
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
      const baseUrl = this.getJiraCloudBaseUrl();
      const epicKey = this.getJiraCloudEpicKey();
      const boardJql = this.getJiraCloudBoardJql();
      return baseUrl
        ? `Jira Cloud (${baseUrl}${epicKey ? `; epic ${epicKey}` : ''}${boardJql ? '; jql board configured' : ''})`
        : 'Jira Cloud (not configured)';
    }

    return 'Not configured';
  }

  public async configureConnection(
    context: vscode.ExtensionContext
  ): Promise<ConfigureConnectionResult> {
    const clientId = await vscode.window.showInputBox({
      title: 'Ticket Manager: Jira Cloud OAuth Client ID',
      prompt: 'Enter the Atlassian OAuth client ID for Jira Cloud.',
      value: this.getJiraOAuthClientId(),
      ignoreFocusOut: true,
      validateInput: value => (value.trim().length > 0 ? undefined : 'Client ID is required.')
    });

    if (clientId === undefined) {
      return { saved: false, description: 'Cancelled' };
    }

    await Promise.all([
      this.setJiraOAuthClientId(clientId),
      this.setBackendMode('jiracloud'),
      vscode.workspace.getConfiguration(CONFIG_ROOT).update('connectionType', undefined, this.configTarget()),
      vscode.workspace.getConfiguration(CONFIG_ROOT).update('stdioCommand', undefined, this.configTarget()),
      vscode.workspace.getConfiguration(CONFIG_ROOT).update('stdioArgs', undefined, this.configTarget()),
      vscode.workspace.getConfiguration(CONFIG_ROOT).update('stdioCwd', undefined, this.configTarget()),
      vscode.workspace.getConfiguration(CONFIG_ROOT).update('httpUrl', undefined, this.configTarget())
    ]);

    return {
      saved: true,
      description: 'Jira Cloud OAuth'
    };
  }

}
