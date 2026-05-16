import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parse as parseJsonc } from 'jsonc-parser';
import type {
  AiAgentRegistration,
  AiProvider,
  BackendMode,
  ConfigureConnectionResult,
  ConnectionConfig,
  ConnectionType,
  DeliveryWorkflowSettings,
  HttpConnectionConfig,
  ResolvedConnectionConfig,
  SecretConnectionValues,
  StdioConnectionConfig,
  WorkspaceMcpCandidate
} from '../types';

const CONFIG_ROOT = 'ticketManager';
const GITLAB_API_KEY_SECRET = 'ticketManager.gitlabApiKey';
const SECRET_ENV_KEY = 'ticketManager.secretEnv';
const SECRET_HEADERS_KEY = 'ticketManager.secretHeaders';
const SECRET_WORKSPACE_INPUTS_KEY = 'ticketManager.workspaceMcpInputs';
const WORKSPACE_SERVER_KEY = 'workspaceMcpServerName';
const USER_SERVER_KEY = 'userMcpServerRef';
const USER_MCP_PATHS_ENV = 'JIRA_MINI_USER_MCP_PATHS';
const POLLING_CONFIG_PATH = path.resolve(__dirname, '..', '..', 'JiraPollingService', 'appsettings.json');

interface JiraPollingDefaults {
  baseUrl: string;
  token: string;
  projectKey: string;
  rapidViewId?: number;
  internalDns: string;
  preferredResolveIp: string;
}

interface WorkspaceInputDefinition {
  type?: string;
  id?: string;
  description?: string;
  password?: boolean;
}

interface WorkspaceMcpFileContext {
  workspaceFolder?: vscode.WorkspaceFolder;
  sourcePath: string;
  inputs: Record<string, WorkspaceInputDefinition>;
}

interface ConfigureConnectionChoice {
  label: string;
  description: string;
  mode: 'manual' | 'workspace' | 'user';
  value?: ConnectionType;
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

function parseWorkspaceObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parseStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      result[key] = entry;
    }
  }

  return result;
}

function parseInputs(value: unknown): Record<string, WorkspaceInputDefinition> {
  const items = Array.isArray(value) ? value : [];
  const result: Record<string, WorkspaceInputDefinition> = {};

  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== 'string') {
      continue;
    }

    result[item.id] = {
      type: typeof item.type === 'string' ? item.type : undefined,
      id: item.id,
      description: typeof item.description === 'string' ? item.description : item.id,
      password: item.password === true
    };
  }

  return result;
}

function buildServerRef(sourcePath: string, serverName: string): string {
  return `${sourcePath}::${serverName}`;
}

export function buildJiraConnectionChoices(
  hasWorkspaceCandidates: boolean,
  hasUserCandidates: boolean
): ConfigureConnectionChoice[] {
  const workspaceChoice: ConfigureConnectionChoice = {
    label: 'Use Workspace MCP Configuration',
    description: 'Reuse a Jira server from .vscode/mcp.json in this workspace.',
    mode: 'workspace'
  };
  const userChoice: ConfigureConnectionChoice = {
    label: 'Use User/Profile MCP Configuration',
    description: 'Reuse a globally configured Jira server from Cursor or VS Code.',
    mode: 'user'
  };
  const manualChoice: ConfigureConnectionChoice = {
    label: 'Manual Setup',
    description: 'Enter a local-process command or a remote MCP server URL yourself.',
    mode: 'manual'
  };

  const choices: ConfigureConnectionChoice[] = [];
  if (hasWorkspaceCandidates) {
    choices.push(workspaceChoice);
  }
  if (hasUserCandidates) {
    choices.push(userChoice);
  }

  choices.push(manualChoice);

  return choices;
}

export function buildManualJiraConnectionChoices(
  existingType: ConnectionType
): ConfigureConnectionChoice[] {
  const stdioChoice: ConfigureConnectionChoice = {
    label: 'Local Process',
    description: 'Start a Jira MCP server over stdio and enter the command yourself.',
    mode: 'manual',
    value: 'stdio'
  };
  const httpChoice: ConfigureConnectionChoice = {
    label: 'Remote MCP Server',
    description: 'Connect to a Jira MCP server over streamable HTTP and enter the URL yourself.',
    mode: 'manual',
    value: 'http'
  };

  return existingType === 'http' ? [httpChoice, stdioChoice] : [stdioChoice, httpChoice];
}

let cachedJiraPollingDefaults: JiraPollingDefaults | undefined;

function loadJiraPollingDefaults(): JiraPollingDefaults {
  if (cachedJiraPollingDefaults) {
    return cachedJiraPollingDefaults;
  }

  const fallback: JiraPollingDefaults = {
    baseUrl: 'https://jira.assaabloy.net',
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
    return this.getBackendMode() ?? 'jira';
  }

  public hasJiraConnectionConfig(): boolean {
    if (this.getSelectedWorkspaceServerName() || this.getSelectedUserServerRef()) {
      return true;
    }

    const config = vscode.workspace.getConfiguration(CONFIG_ROOT);
    const connectionType = config.get<ConnectionType>('connectionType', 'stdio');
    if (connectionType === 'http') {
      return config.get<string>('httpUrl', '').trim().length > 0;
    }

    return config.get<string>('stdioCommand', '').trim().length > 0;
  }

  public hasJiraApiConfig(): boolean {
    if (this.getJiraCloudId().length > 0) {
      return true;
    }
    return (
      this.getJiraApiBaseUrl().trim().length > 0 &&
      this.getJiraApiToken().trim().length > 0
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

  public getJiraMcpCloudId(): string | undefined {
    const value = vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('jiraMcpCloudId', '');
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  public getJiraCloudId(): string {
    const config = vscode.workspace.getConfiguration(CONFIG_ROOT);
    const explicitCloudId = config.get<string>('jiraCloudId', '').trim();
    if (explicitCloudId) {
      return explicitCloudId;
    }

    const mcpCloudId = this.getJiraMcpCloudId();
    if (mcpCloudId && !/^https?:\/\//i.test(mcpCloudId)) {
      return mcpCloudId;
    }

    return '';
  }

  public getJiraCloudSiteUrl(): string {
    const config = vscode.workspace.getConfiguration(CONFIG_ROOT);
    const configured = config.get<string>('jiraCloudSiteUrl', '').trim();
    if (configured) {
      return configured;
    }

    const mcpCloudId = this.getJiraMcpCloudId();
    if (mcpCloudId && /^https?:\/\//i.test(mcpCloudId)) {
      return mcpCloudId;
    }

    return '';
  }

  public getJiraOAuthClientId(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('jiraOAuthClientId', '').trim();
  }

  public getJiraOAuthClientSecret(): string {
    return '';
  }

  public getJiraOAuthScopes(): string[] {
    const configured = vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .get<string[]>('jiraOAuthScopes', [])
      .map(scope => scope.trim())
      .filter(scope => scope.length > 0);
    if (configured.length > 0) {
      return configured;
    }

    return ['offline_access', 'read:jira-work', 'write:jira-work', 'read:me'];
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
      config.update('jiraCloudSiteUrl', cloudUrl, target),
      config.update('jiraMcpCloudId', cloudId || cloudUrl, target)
    ]);
  }

  public isJiraStartupPollingEnabled(): boolean {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<boolean>('jiraPolling.enabled', true);
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

  public getJiraApiInternalDns(): string {
    return loadJiraPollingDefaults().internalDns;
  }

  public getJiraApiPreferredResolveIp(): string {
    return loadJiraPollingDefaults().preferredResolveIp;
  }

  public getJiraApiBaseUrl(): string {
    const configured = this.getWorkspaceScopedConfigValue<string>('jiraApiBaseUrl', '').trim();
    return configured || loadJiraPollingDefaults().baseUrl;
  }

  public getJiraApiToken(): string {
    const configured = this.getWorkspaceScopedConfigValue<string>('jiraApiToken', '').trim();
    return configured || process.env.JIRA_TOKEN?.trim() || loadJiraPollingDefaults().token;
  }

  public getJiraApiEpicKey(): string {
    return this.getWorkspaceScopedConfigValue<string>('jiraApiEpicKey', '').trim();
  }

  public getJiraApiEpicBoardName(): string {
    return this.getWorkspaceScopedConfigValue<string>('jiraApiEpicBoardName', '').trim();
  }

  public getJiraApiBoardJql(): string {
    return this.getWorkspaceScopedConfigValue<string>('jiraApiBoardJql', '').trim();
  }

  public getJiraApiBoardName(): string {
    return this.getWorkspaceScopedConfigValue<string>('jiraApiBoardName', '').trim();
  }

  public async setJiraApiBaseUrl(value: string): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace.getConfiguration(CONFIG_ROOT).update('jiraApiBaseUrl', value, target);
  }

  public async setJiraApiToken(value: string): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace.getConfiguration(CONFIG_ROOT).update('jiraApiToken', value, target);
  }

  public async setJiraApiEpicKey(value: string | undefined): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .update('jiraApiEpicKey', value?.trim() ?? '', target);
  }

  public async setJiraApiEpicBoardName(value: string | undefined): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .update('jiraApiEpicBoardName', value?.trim() ?? '', target);
  }

  public async setJiraApiBoardJql(value: string | undefined): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .update('jiraApiBoardJql', value?.trim() ?? '', target);
  }

  public async setJiraApiBoardName(value: string | undefined): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace
      .getConfiguration(CONFIG_ROOT)
      .update('jiraApiBoardName', value?.trim() ?? '', target);
  }

  // ── GitHub settings ──────────────────────────────────────────────

  public getGitHubPat(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('githubPat', '');
  }

  public getGitHubUrl(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('githubUrl', 'https://api.github.com');
  }

  public getGitHubOwner(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('githubOwner', '');
  }

  public async setGitHubPat(value: string): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace.getConfiguration(CONFIG_ROOT).update('githubPat', value, target);
  }

  public async setGitHubUrl(value: string): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace.getConfiguration(CONFIG_ROOT).update('githubUrl', value, target);
  }

  public async setGitHubOwner(value: string): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace.getConfiguration(CONFIG_ROOT).update('githubOwner', value, target);
  }

  // ── GitLab settings ──────────────────────────────────────────────

  public getGitLabUrl(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('gitlabUrl', '');
  }

  public getGitLabConnectionType(): 'api' | 'mcp' {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<'api' | 'mcp'>('gitlabConnectionType', 'api');
  }

  // Only retained for one-time migration from settings to SecretStorage.
  public getGitLabApiKey(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('gitlabApiKey', '');
  }

  public async getGitLabApiKeyFromSecrets(context: vscode.ExtensionContext): Promise<string> {
    const fromSecrets = await context.secrets.get(GITLAB_API_KEY_SECRET);
    if (fromSecrets !== undefined) {
      return fromSecrets.trim();
    }
    // Fallback to legacy settings value during migration
    return this.getGitLabApiKey().trim();
  }

  public async storeGitLabApiKey(context: vscode.ExtensionContext, value: string): Promise<void> {
    await context.secrets.store(GITLAB_API_KEY_SECRET, value);
  }

  public async deleteGitLabApiKeySecret(context: vscode.ExtensionContext): Promise<void> {
    await context.secrets.delete(GITLAB_API_KEY_SECRET);
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

  public getGitLabMcpCommand(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>('gitlabMcpCommand', '');
  }

  public getGitLabMcpArgs(): string[] {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string[]>('gitlabMcpArgs', []);
  }

  public async setGitLabUrl(value: string): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace.getConfiguration(CONFIG_ROOT).update('gitlabUrl', value, target);
  }

  public async setGitLabConnectionType(value: 'api' | 'mcp'): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace.getConfiguration(CONFIG_ROOT).update('gitlabConnectionType', value, target);
  }

  // Use storeGitLabApiKey/deleteGitLabApiKeySecret for new code. Kept only to clear legacy settings value.
  public async setGitLabApiKey(value: string): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace.getConfiguration(CONFIG_ROOT).update('gitlabApiKey', value, target);
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

  public async getConnectionConfig(
    context: vscode.ExtensionContext
  ): Promise<ConnectionConfig | undefined> {
    const resolved = await this.getResolvedConnectionConfig(context);
    return resolved?.config;
  }

  public async getResolvedConnectionConfig(
    context: vscode.ExtensionContext
  ): Promise<ResolvedConnectionConfig | undefined> {
    const manualConfig = await this.getManualConnectionConfig(context);
    if (manualConfig) {
      return {
        config: manualConfig,
        source: 'manual',
        description:
          manualConfig.type === 'http'
            ? `HTTP ${manualConfig.url}`
            : `stdio ${manualConfig.command}${manualConfig.args.length > 0 ? ` ${manualConfig.args.join(' ')}` : ''}`
      };
    }

    const workspaceConfig = await this.getWorkspaceMcpConnection(context);
    if (workspaceConfig) {
      return workspaceConfig;
    }

    return this.getUserMcpConnection(context);
  }

  public async getWorkspaceMcpCandidates(
    context: vscode.ExtensionContext
  ): Promise<WorkspaceMcpCandidate[]> {
    const timeoutMs = this.getRequestTimeoutMs();
    const candidates: WorkspaceMcpCandidate[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

    for (const workspaceFolder of workspaceFolders) {
      const mcpUri = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'mcp.json');
      let contents: Uint8Array;
      try {
        contents = await vscode.workspace.fs.readFile(mcpUri);
      } catch {
        continue;
      }

      const sourcePath = mcpUri.fsPath;
      const text = Buffer.from(contents).toString('utf8');
      const parsed = parseJsonc(text);
      if (!isRecord(parsed)) {
        continue;
      }

      const servers = parseWorkspaceObject(parsed.servers);
      const fileContext: WorkspaceMcpFileContext = {
        workspaceFolder,
        sourcePath,
        inputs: parseInputs(parsed.inputs)
      };

      for (const [serverName, rawServer] of Object.entries(servers)) {
        const candidate = await this.parseWorkspaceServerCandidate(
          context,
          serverName,
          rawServer,
          fileContext,
          timeoutMs
        );

        if (candidate) {
          candidates.push(candidate);
        }
      }
    }

    return candidates;
  }

  public async getUserMcpCandidates(
    context: vscode.ExtensionContext
  ): Promise<WorkspaceMcpCandidate[]> {
    const timeoutMs = this.getRequestTimeoutMs();
    const candidates: WorkspaceMcpCandidate[] = [];
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    for (const sourcePath of this.getKnownUserMcpPaths()) {
      let contents: Uint8Array;
      try {
        contents = await vscode.workspace.fs.readFile(vscode.Uri.file(sourcePath));
      } catch {
        continue;
      }

      const text = Buffer.from(contents).toString('utf8');
      const parsed = parseJsonc(text);
      if (!isRecord(parsed)) {
        continue;
      }

      const servers = parseWorkspaceObject(parsed.servers ?? parsed.mcpServers);
      const fileContext: WorkspaceMcpFileContext = {
        workspaceFolder,
        sourcePath,
        inputs: parseInputs(parsed.inputs)
      };

      for (const [serverName, rawServer] of Object.entries(servers)) {
        const candidate = await this.parseWorkspaceServerCandidate(
          context,
          serverName,
          rawServer,
          fileContext,
          timeoutMs
        );

        if (candidate) {
          candidates.push(candidate);
        }
      }
    }

    return candidates;
  }

  public async importWorkspaceMcpConfig(
    context: vscode.ExtensionContext
  ): Promise<ConfigureConnectionResult> {
    const candidates = await this.getWorkspaceMcpCandidates(context);
    if (candidates.length === 0) {
      throw new Error('No workspace Jira MCP server was found in .vscode/mcp.json.');
    }

    const picked:
      | WorkspaceMcpCandidate
      | { label: string; description: string; detail: string; candidate: WorkspaceMcpCandidate }
      | undefined =
      candidates.length === 1
        ? candidates[0]
        : await vscode.window.showQuickPick(
            candidates.map(candidate => ({
              label: candidate.serverName,
              description: candidate.label,
              detail: candidate.sourcePath,
              candidate
            })),
            {
              title: 'Ticket Manager: Use Workspace MCP Configuration'
            }
          );

    const selectedCandidate = picked
      ? 'candidate' in picked
        ? picked.candidate
        : picked
      : undefined;
    if (!selectedCandidate) {
      return {
        saved: false,
        description: 'Cancelled'
      };
    }

    const configuration = vscode.workspace.getConfiguration(CONFIG_ROOT);
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

    await Promise.all([
      configuration.update('backendMode', 'jira', target),
      configuration.update(WORKSPACE_SERVER_KEY, selectedCandidate.serverName, target),
      configuration.update(USER_SERVER_KEY, '', vscode.ConfigurationTarget.Global),
      configuration.update('connectionType', selectedCandidate.config.type, target),
      configuration.update('stdioCommand', '', target),
      configuration.update('stdioArgs', [], target),
      configuration.update('stdioCwd', '', target),
      configuration.update('httpUrl', '', target)
    ]);

    return {
      saved: true,
      description: `Workspace MCP ${selectedCandidate.serverName}`
    };
  }

  public async importUserMcpConfig(
    context: vscode.ExtensionContext
  ): Promise<ConfigureConnectionResult> {
    const candidates = await this.getUserMcpCandidates(context);
    if (candidates.length === 0) {
      throw new Error('No user/profile Jira MCP server was found.');
    }

    const picked:
      | WorkspaceMcpCandidate
      | { label: string; description: string; detail: string; candidate: WorkspaceMcpCandidate }
      | undefined =
      candidates.length === 1
        ? candidates[0]
        : await vscode.window.showQuickPick(
            candidates.map(candidate => ({
              label: candidate.serverName,
              description: candidate.label,
              detail: candidate.sourcePath,
              candidate
            })),
            {
              title: 'Ticket Manager: Use User/Profile MCP Configuration'
            }
          );

    const selectedCandidate = picked
      ? 'candidate' in picked
        ? picked.candidate
        : picked
      : undefined;

    if (!selectedCandidate) {
      return {
        saved: false,
        description: 'Cancelled'
      };
    }

    const configuration = vscode.workspace.getConfiguration(CONFIG_ROOT);
    const target = vscode.ConfigurationTarget.Global;
    const backendTarget = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

    await Promise.all([
      configuration.update('backendMode', 'jira', backendTarget),
      configuration.update(USER_SERVER_KEY, buildServerRef(selectedCandidate.sourcePath, selectedCandidate.serverName), target),
      configuration.update(WORKSPACE_SERVER_KEY, '', vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global),
      configuration.update('connectionType', selectedCandidate.config.type, target),
      configuration.update('stdioCommand', '', target),
      configuration.update('stdioArgs', [], target),
      configuration.update('stdioCwd', '', target),
      configuration.update('httpUrl', '', target)
    ]);

    return {
      saved: true,
      description: `User MCP ${selectedCandidate.serverName}`
    };
  }

  public getSelectedWorkspaceServerName(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>(WORKSPACE_SERVER_KEY, '').trim();
  }

  public getSelectedUserServerRef(): string {
    return vscode.workspace.getConfiguration(CONFIG_ROOT).get<string>(USER_SERVER_KEY, '').trim();
  }

  public async describeConnection(context: vscode.ExtensionContext): Promise<string> {
    if (this.getEffectiveBackendMode() === 'demo') {
      return 'Demo mode';
    }

    if (this.getEffectiveBackendMode() === 'gitlab') {
      const baseUrl = this.getGitLabUrl().trim();
      const projectPath = this.getGitLabProjectPath().trim();
      if (projectPath) {
        return baseUrl ? `GitLab (${projectPath} @ ${baseUrl})` : `GitLab (${projectPath})`;
      }
      return baseUrl ? `GitLab (${baseUrl})` : 'GitLab';
    }

    if (this.getEffectiveBackendMode() === 'github') {
      const owner = this.getGitHubOwner().trim();
      const baseUrl = this.getGitHubUrl().trim();
      if (owner) {
        return baseUrl ? `GitHub (${owner} @ ${baseUrl})` : `GitHub (${owner})`;
      }
      return baseUrl ? `GitHub (${baseUrl})` : 'GitHub';
    }

    if (this.getEffectiveBackendMode() === 'livefolder') {
      const folderPath = this.getLiveFolderPath();
      return folderPath ? `Live Folder (${folderPath})` : 'Live Folder (not configured)';
    }

    if (this.getEffectiveBackendMode() === 'userworkspace') {
      return 'User Workspace';
    }

    if (this.getEffectiveBackendMode() === 'jiraapi') {
      const baseUrl = this.getJiraApiBaseUrl();
      const epicKey = this.getJiraApiEpicKey();
      const boardJql = this.getJiraApiBoardJql();
      return baseUrl
        ? `Jira API (${baseUrl}${epicKey ? `; epic ${epicKey}` : ''}${boardJql ? '; jql board configured' : ''})`
        : 'Jira API (not configured)';
    }

    const resolved = await this.getResolvedConnectionConfig(context);
    if (!resolved) {
      return 'Not configured';
    }

    return resolved.source === 'workspaceMcp'
      ? `Workspace MCP ${resolved.description}`
      : resolved.source === 'manual'
        ? resolved.description
        : `User MCP ${resolved.description}`;
  }

  private async getManualConnectionConfig(
    context: vscode.ExtensionContext
  ): Promise<ConnectionConfig | undefined> {
    const config = vscode.workspace.getConfiguration(CONFIG_ROOT);
    const secrets = await this.getSecretValues(context);
    const timeoutMs = this.getRequestTimeoutMs();
    const connectionType = config.get<ConnectionType>('connectionType', 'stdio');

    if (connectionType === 'http') {
      const url = config.get<string>('httpUrl', '').trim();
      if (!url) {
        return undefined;
      }

      const httpConfig: HttpConnectionConfig = {
        type: 'http',
        url,
        headers: secrets.headers,
        timeoutMs
      };
      return httpConfig;
    }

    const command = config.get<string>('stdioCommand', '').trim();
    if (!command) {
      return undefined;
    }

    const stdioConfig: StdioConnectionConfig = {
      type: 'stdio',
      command,
      args: asStringArray(config.get<unknown>('stdioArgs', [])),
      cwd: config.get<string>('stdioCwd', '').trim() || undefined,
      env: secrets.env,
      timeoutMs
    };
    return stdioConfig;
  }

  public async configureConnection(
    context: vscode.ExtensionContext
  ): Promise<ConfigureConnectionResult> {
    const configuration = vscode.workspace.getConfiguration(CONFIG_ROOT);
    const existingType = this.getConnectionType();
    const existingSecrets = await this.getSecretValues(context);
    const [workspaceCandidates, userCandidates] = await Promise.all([
      this.getWorkspaceMcpCandidates(context),
      this.getUserMcpCandidates(context)
    ]);

    const selectedType = await vscode.window.showQuickPick<ConfigureConnectionChoice>(
      buildJiraConnectionChoices(
        workspaceCandidates.length > 0,
        userCandidates.length > 0
      ),
      {
        title: 'Ticket Manager: Jira MCP Connection Type',
        placeHolder: 'Choose an existing Jira MCP source or configure a manual connection.'
      }
    );

    if (!selectedType) {
      return { saved: false, description: 'Cancelled' };
    }

    if (selectedType.mode === 'workspace') {
      return this.importWorkspaceMcpConfig(context);
    }

    if (selectedType.mode === 'user') {
      return this.importUserMcpConfig(context);
    }

    const manualType = await vscode.window.showQuickPick<ConfigureConnectionChoice>(
      buildManualJiraConnectionChoices(existingType),
      {
        title: 'Ticket Manager: Jira MCP Manual Connection',
        placeHolder: 'Choose how you want to connect manually.'
      }
    );

    if (!manualType?.value) {
      return { saved: false, description: 'Cancelled' };
    }

    if (manualType.value === 'stdio') {
      const command = await vscode.window.showInputBox({
        title: 'Ticket Manager: Jira MCP stdio command',
        prompt: 'Command used to start the Jira MCP server.',
        value: configuration.get<string>('stdioCommand', ''),
        ignoreFocusOut: true,
        validateInput: value => (value.trim().length > 0 ? undefined : 'Command is required.')
      });

      if (!command) {
        return { saved: false, description: 'Cancelled' };
      }

      const argsInput = await vscode.window.showInputBox({
        title: 'Ticket Manager: Jira MCP stdio arguments',
        prompt: 'Arguments as a JSON array of strings.',
        value: formatJson(asStringArray(configuration.get<unknown>('stdioArgs', []))),
        ignoreFocusOut: true
      });

      if (argsInput === undefined) {
        return { saved: false, description: 'Cancelled' };
      }

      const cwd = await vscode.window.showInputBox({
        title: 'Ticket Manager: Jira MCP working directory',
        prompt: 'Optional working directory for the Jira MCP server process.',
        value: configuration.get<string>('stdioCwd', ''),
        ignoreFocusOut: true
      });

      if (cwd === undefined) {
        return { saved: false, description: 'Cancelled' };
      }

      const envInput = await vscode.window.showInputBox({
        title: 'Ticket Manager: environment variables',
        prompt: 'Optional environment variables as a JSON object.',
        value: formatJson(existingSecrets.env),
        ignoreFocusOut: true
      });

      if (envInput === undefined) {
        return { saved: false, description: 'Cancelled' };
      }

      const parsedArgs = parseJsonArray(argsInput, 'stdio arguments');
      const parsedEnv = parseJsonObject(envInput, 'environment variables');

      const clearWorkspaceTarget = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

      await Promise.all([
        configuration.update('backendMode', 'jira', clearWorkspaceTarget),
        configuration.update('connectionType', 'stdio', vscode.ConfigurationTarget.Global),
        configuration.update('stdioCommand', command.trim(), vscode.ConfigurationTarget.Global),
        configuration.update('stdioArgs', parsedArgs, vscode.ConfigurationTarget.Global),
        configuration.update('stdioCwd', cwd.trim(), vscode.ConfigurationTarget.Global),
        configuration.update(WORKSPACE_SERVER_KEY, '', clearWorkspaceTarget),
        configuration.update(USER_SERVER_KEY, '', vscode.ConfigurationTarget.Global),
        context.secrets.store(SECRET_ENV_KEY, JSON.stringify(parsedEnv)),
        context.secrets.store(SECRET_HEADERS_KEY, JSON.stringify(existingSecrets.headers))
      ]);

      return {
        saved: true,
        description: `stdio ${command.trim()}${parsedArgs.length > 0 ? ` ${parsedArgs.join(' ')}` : ''}`
      };
    }

    const url = await vscode.window.showInputBox({
      title: 'Ticket Manager: Jira MCP HTTP URL',
      prompt: 'Base URL for the Jira MCP server.',
      value: configuration.get<string>('httpUrl', ''),
      ignoreFocusOut: true,
      validateInput: value => (value.trim().length > 0 ? undefined : 'HTTP URL is required.')
    });

    if (!url) {
      return { saved: false, description: 'Cancelled' };
    }

    const headersInput = await vscode.window.showInputBox({
      title: 'Ticket Manager: HTTP headers',
      prompt: 'Optional HTTP headers as a JSON object.',
      value: formatJson(existingSecrets.headers),
      ignoreFocusOut: true
    });

    if (headersInput === undefined) {
      return { saved: false, description: 'Cancelled' };
    }

    const parsedHeaders = parseJsonObject(headersInput, 'HTTP headers');
    const clearWorkspaceTarget = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

    await Promise.all([
      configuration.update('backendMode', 'jira', clearWorkspaceTarget),
      configuration.update('connectionType', 'http', vscode.ConfigurationTarget.Global),
      configuration.update('httpUrl', url.trim(), vscode.ConfigurationTarget.Global),
      configuration.update(WORKSPACE_SERVER_KEY, '', clearWorkspaceTarget),
      configuration.update(USER_SERVER_KEY, '', vscode.ConfigurationTarget.Global),
      context.secrets.store(SECRET_HEADERS_KEY, JSON.stringify(parsedHeaders)),
      context.secrets.store(SECRET_ENV_KEY, JSON.stringify(existingSecrets.env))
    ]);

    return {
      saved: true,
      description: `HTTP ${url.trim()}`
    };
  }

  private async getWorkspaceMcpConnection(
    context: vscode.ExtensionContext
  ): Promise<ResolvedConnectionConfig | undefined> {
    const candidates = await this.getWorkspaceMcpCandidates(context);
    if (candidates.length === 0) {
      return undefined;
    }

    const selectedName = this.getSelectedWorkspaceServerName();
    const selectedCandidate = selectedName
      ? candidates.find(candidate => candidate.serverName === selectedName)
      : this.pickAutoWorkspaceCandidate(candidates);

    if (!selectedCandidate) {
      if (selectedName) {
        throw new Error(
          `Workspace MCP server "${selectedName}" is no longer available. Run "Ticket Manager: Use Workspace MCP Configuration".`
        );
      }

      throw new Error(
        'Multiple workspace MCP servers were found. Run "Ticket Manager: Use Workspace MCP Configuration" to choose the Jira server.'
      );
    }

    return {
      config: selectedCandidate.config,
      source: 'workspaceMcp',
      description: selectedCandidate.serverName
    };
  }

  private pickAutoWorkspaceCandidate(
    candidates: WorkspaceMcpCandidate[]
  ): WorkspaceMcpCandidate | undefined {
    const jiraLikeCandidates = candidates.filter(candidate => candidate.isJiraLike);

    if (jiraLikeCandidates.length === 1) {
      return jiraLikeCandidates[0];
    }

    if (jiraLikeCandidates.length > 1) {
      return undefined;
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    return undefined;
  }

  private async getUserMcpConnection(
    context: vscode.ExtensionContext
  ): Promise<ResolvedConnectionConfig | undefined> {
    const candidates = await this.getUserMcpCandidates(context);
    if (candidates.length === 0) {
      return undefined;
    }

    const selectedRef = this.getSelectedUserServerRef();
    const selectedCandidate = selectedRef
      ? candidates.find(candidate => buildServerRef(candidate.sourcePath, candidate.serverName) === selectedRef)
      : this.pickAutoWorkspaceCandidate(candidates);

    if (!selectedCandidate) {
      if (selectedRef) {
        throw new Error(
          'The selected user/profile MCP server is no longer available. Run "Ticket Manager: Use User/Profile MCP Configuration".'
        );
      }

      throw new Error(
        'Multiple user/profile MCP servers were found. Run "Ticket Manager: Use User/Profile MCP Configuration" to choose the Jira server.'
      );
    }

    return {
      config: selectedCandidate.config,
      source: 'userMcp',
      description: selectedCandidate.serverName
    };
  }

  private getKnownUserMcpPaths(): string[] {
    const hostName = vscode.env.appName.toLowerCase();
    const appData = process.env.APPDATA;
    const paths: string[] = [];

    const pushUnique = (candidate: string | undefined): void => {
      if (!candidate) {
        return;
      }
      const normalized = path.normalize(candidate);
      if (!paths.includes(normalized)) {
        paths.push(normalized);
      }
    };

    const overridePaths = process.env[USER_MCP_PATHS_ENV]
      ?.split(path.delimiter)
      .map(value => value.trim())
      .filter(Boolean);

    if (overridePaths && overridePaths.length > 0) {
      for (const overridePath of overridePaths) {
        pushUnique(overridePath);
      }
      return paths;
    }

    const cursorUserDir = path.join(os.homedir(), '.cursor');
    const codeUserDir = appData ? path.join(appData, 'Code', 'User') : undefined;
    const insidersUserDir = appData ? path.join(appData, 'Code - Insiders', 'User') : undefined;

    const defaultCursorPath = path.join(cursorUserDir, 'mcp.json');
    const defaultCodePath = codeUserDir ? path.join(codeUserDir, 'mcp.json') : undefined;
    const defaultInsidersPath = insidersUserDir ? path.join(insidersUserDir, 'mcp.json') : undefined;
    const legacyCursorRoamingPath = appData ? path.join(appData, 'Cursor', 'User', 'mcp.json') : undefined;

    const pushProfilePaths = (userDir: string | undefined): void => {
      if (!userDir) {
        return;
      }

      const profilesDir = path.join(userDir, 'profiles');
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(profilesDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        pushUnique(path.join(profilesDir, entry.name, 'mcp.json'));
      }
    };

    if (hostName.includes('cursor')) {
      pushUnique(defaultCursorPath);
      pushUnique(legacyCursorRoamingPath);
      pushUnique(defaultCodePath);
      pushUnique(defaultInsidersPath);
      pushProfilePaths(codeUserDir);
      pushProfilePaths(insidersUserDir);
    } else if (hostName.includes('insiders')) {
      pushUnique(defaultInsidersPath);
      pushUnique(defaultCodePath);
      pushUnique(defaultCursorPath);
      pushUnique(legacyCursorRoamingPath);
      pushProfilePaths(insidersUserDir);
      pushProfilePaths(codeUserDir);
    } else {
      pushUnique(defaultCodePath);
      pushUnique(defaultInsidersPath);
      pushUnique(defaultCursorPath);
      pushUnique(legacyCursorRoamingPath);
      pushProfilePaths(codeUserDir);
      pushProfilePaths(insidersUserDir);
    }

    return paths;
  }

  private async parseWorkspaceServerCandidate(
    context: vscode.ExtensionContext,
    serverName: string,
    rawServer: unknown,
    fileContext: WorkspaceMcpFileContext,
    timeoutMs: number
  ): Promise<WorkspaceMcpCandidate | undefined> {
    if (!isRecord(rawServer)) {
      return undefined;
    }

    const type = asString(rawServer.type);
    const command = asString(rawServer.command);
    const url = asString(rawServer.url);
    const labelText = `${serverName} ${command ?? ''} ${url ?? ''} ${asStringArray(rawServer.args).join(' ')}`.toLowerCase();

    if ((type === 'http' || type === 'sse' || url) && url) {
      const headers = await this.resolveStringRecord(
        context,
        parseStringRecord(rawServer.headers),
        fileContext
      );
      return {
        serverName,
        label: `HTTP ${url}`,
        sourcePath: fileContext.sourcePath,
        isJiraLike: /jira|atlassian/.test(labelText),
        config: {
          type: 'http',
          url: await this.resolveString(context, url, fileContext),
          headers,
          timeoutMs
        }
      };
    }

    if (!command) {
      return undefined;
    }

    const resolvedCommand = await this.resolveString(context, command, fileContext);
    const resolvedArgs = await this.resolveStringArray(
      context,
      asStringArray(rawServer.args),
      fileContext
    );
    const resolvedCwd = await this.resolveOptionalString(
      context,
      asString(rawServer.cwd),
      fileContext
    );
    const envFromFile = await this.readEnvFileValues(context, asString(rawServer.envFile), fileContext);
    const resolvedEnv = await this.resolveStringRecord(
      context,
      {
        ...envFromFile,
        ...parseStringRecord(rawServer.env)
      },
      fileContext
    );

    return {
      serverName,
      label: `stdio ${resolvedCommand}${resolvedArgs.length > 0 ? ` ${resolvedArgs.join(' ')}` : ''}`,
      sourcePath: fileContext.sourcePath,
      isJiraLike: /jira|atlassian/.test(labelText),
      config: {
        type: 'stdio',
        command: resolvedCommand,
        args: resolvedArgs,
        cwd: resolvedCwd,
        env: resolvedEnv,
        timeoutMs
      }
    };
  }

  private async readEnvFileValues(
    context: vscode.ExtensionContext,
    envFile: string | undefined,
    fileContext: WorkspaceMcpFileContext
  ): Promise<Record<string, string>> {
    if (!envFile) {
      return {};
    }

    const resolvedPath = await this.resolveString(context, envFile, fileContext);
    const absolutePath = path.isAbsolute(resolvedPath)
      ? resolvedPath
      : fileContext.workspaceFolder
        ? path.join(fileContext.workspaceFolder.uri.fsPath, resolvedPath)
        : path.join(path.dirname(fileContext.sourcePath), resolvedPath);

    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absolutePath));
      const text = Buffer.from(bytes).toString('utf8');
      return this.parseEnvFile(text);
    } catch (error) {
      throw new Error(`Unable to read MCP envFile "${absolutePath}": ${(error as Error).message}`);
    }
  }

  private parseEnvFile(text: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }

      const equalsIndex = line.indexOf('=');
      if (equalsIndex <= 0) {
        continue;
      }

      const key = line.slice(0, equalsIndex).trim();
      let value = line.slice(equalsIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      result[key] = value;
    }

    return result;
  }

  private async resolveStringRecord(
    context: vscode.ExtensionContext,
    record: Record<string, string>,
    fileContext: WorkspaceMcpFileContext
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      result[key] = await this.resolveString(context, value, fileContext);
    }
    return result;
  }

  private async resolveStringArray(
    context: vscode.ExtensionContext,
    values: string[],
    fileContext: WorkspaceMcpFileContext
  ): Promise<string[]> {
    const result: string[] = [];
    for (const value of values) {
      result.push(await this.resolveString(context, value, fileContext));
    }
    return result;
  }

  private async resolveOptionalString(
    context: vscode.ExtensionContext,
    value: string | undefined,
    fileContext: WorkspaceMcpFileContext
  ): Promise<string | undefined> {
    return value ? this.resolveString(context, value, fileContext) : undefined;
  }

  private async resolveString(
    context: vscode.ExtensionContext,
    value: string,
    fileContext: WorkspaceMcpFileContext
  ): Promise<string> {
    const variablePattern = /\$\{([^}]+)\}/g;
    let result = '';
    let lastIndex = 0;

    for (const match of value.matchAll(variablePattern)) {
      result += value.slice(lastIndex, match.index);
      lastIndex = (match.index ?? 0) + match[0].length;

      const token = match[1];
      if (token === 'workspaceFolder') {
        result += fileContext.workspaceFolder?.uri.fsPath ?? '';
      } else if (token === 'workspaceFolderBasename') {
        result += fileContext.workspaceFolder?.name ?? '';
      } else if (token === 'userHome') {
        result += os.homedir();
      } else if (token === 'pathSeparator' || token === '/') {
        result += path.sep;
      } else if (token.startsWith('env:')) {
        result += process.env[token.slice(4)] ?? '';
      } else if (token.startsWith('input:')) {
        result += await this.getWorkspaceInputValue(context, token.slice(6), fileContext);
      } else {
        result += match[0];
      }
    }

    result += value.slice(lastIndex);
    return result;
  }

  private async getWorkspaceInputValue(
    context: vscode.ExtensionContext,
    inputId: string,
    fileContext: WorkspaceMcpFileContext
  ): Promise<string> {
    const inputDefinition = fileContext.inputs[inputId];
    if (!inputDefinition) {
      throw new Error(`MCP input "${inputId}" is not defined in ${fileContext.sourcePath}.`);
    }

    if (inputDefinition.type && inputDefinition.type !== 'promptString') {
      throw new Error(
        `MCP input "${inputId}" uses unsupported type "${inputDefinition.type}".`
      );
    }

    const secretStorage = await this.getWorkspaceInputsSecretStore(context);
    const key = `${fileContext.sourcePath}:${inputId}`;
    const existingValue = secretStorage[key];
    if (existingValue) {
      return existingValue;
    }

    const enteredValue = await vscode.window.showInputBox({
      title: `Ticket Manager: ${inputDefinition.description ?? inputId}`,
      prompt: `Enter the MCP input value for "${inputId}".`,
      password: inputDefinition.password === true,
      ignoreFocusOut: true,
      validateInput: value => (value.trim().length > 0 ? undefined : 'A value is required.')
    });

    if (!enteredValue) {
      throw new Error(`MCP input "${inputId}" was not provided.`);
    }

    secretStorage[key] = enteredValue;
    await context.secrets.store(SECRET_WORKSPACE_INPUTS_KEY, JSON.stringify(secretStorage));
    return enteredValue;
  }

  private async getWorkspaceInputsSecretStore(
    context: vscode.ExtensionContext
  ): Promise<Record<string, string>> {
    const raw = await context.secrets.get(SECRET_WORKSPACE_INPUTS_KEY);
    return raw ? parseJsonObject(raw, 'workspace MCP inputs') : {};
  }

  private async pathExists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private resolvePathToUri(filePath: string): vscode.Uri {
    if (path.isAbsolute(filePath)) {
      return vscode.Uri.file(path.normalize(filePath));
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      return vscode.Uri.joinPath(workspaceFolder.uri, filePath);
    }

    return vscode.Uri.file(path.normalize(filePath));
  }
}
