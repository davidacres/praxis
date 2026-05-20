import * as vscode from 'vscode';
import type { Connection } from '../types';
import type { AppConfigStore } from './jiraConfig';

/**
 * Per-connection secret values resolved synchronously so the scoped config
 * store can satisfy the existing synchronous getter signatures on
 * `AppConfigStore` (e.g. `getJiraCloudToken(): string`).
 *
 * Populated by `loadConnectionSecrets()` before the scoped store is built.
 */
export interface ConnectionSecretsSnapshot {
  jiraCloudToken?: string;
  oauthClientSecret?: string;
  gitlabApiKey?: string;
  githubPat?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(settings: Record<string, unknown>, key: string): string | undefined {
  const value = settings[key];
  return typeof value === 'string' ? value : undefined;
}

function getStringArray(settings: Record<string, unknown>, key: string): string[] | undefined {
  const value = settings[key];
  if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
    return value;
  }
  return undefined;
}

function getBoolean(settings: Record<string, unknown>, key: string): boolean | undefined {
  const value = settings[key];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Loads connection-scoped secrets from `ConnectionStore` SecretStorage so the
 * scoped config store can serve them synchronously.
 */
export async function loadConnectionSecrets(
  context: vscode.ExtensionContext,
  connection: Connection
): Promise<ConnectionSecretsSnapshot> {
  const secretKey = (name: string): string =>
    `ticketManager.connection.${connection.id}.${name}`;
  const [jiraCloudToken, oauthClientSecret, gitlabApiKey, githubPat] = await Promise.all([
    context.secrets.get(secretKey('jiraCloudToken')).then(value => value ?? context.secrets.get(secretKey('token'))),
    context.secrets
      .get(secretKey('oauthClientSecret'))
      .then(value => value ?? context.secrets.get(secretKey('jiraOAuthClientSecret'))),
    context.secrets.get(secretKey('gitlabApiKey')).then(value => value ?? context.secrets.get(secretKey('apiKey'))),
    context.secrets.get(secretKey('githubPat')).then(value => value ?? context.secrets.get(secretKey('pat')))
  ]);
  return { jiraCloudToken, oauthClientSecret, gitlabApiKey, githubPat };
}

/**
 * Builds a connection-scoped view of `AppConfigStore`. Only the getters whose
 * values are mode-specific are overridden; everything else passes through to
 * the base store. The returned object has the exact `AppConfigStore` shape so
 * existing services accept it unchanged.
 *
 * Secrets are resolved synchronously from `secrets` so getters that need to
 * return a string (e.g. `getJiraCloudToken`) keep their existing signature.
 */
export function createConnectionScopedConfigStore(
  base: AppConfigStore,
  connection: Connection,
  secrets: ConnectionSecretsSnapshot
): AppConfigStore {
  const settings = isRecord(connection.settings) ? connection.settings : {};

  type Overrides = Record<string, (...args: unknown[]) => unknown>;

  const overrides: Overrides = {
    // ── Backend mode (always reflects this connection) ───────────────
    getBackendMode: () => connection.mode,
    getEffectiveBackendMode: () => connection.mode,

    // ── Jira Cloud ───────────────────────────────────────────────────
    getConnectionType: () => getString(settings, 'connectionType') ?? base.getConnectionType(),
    getJiraCloudId: () => {
      const cloudId = getString(settings, 'cloudId')?.trim();
      return cloudId && cloudId.length > 0 ? cloudId : base.getJiraCloudId();
    },
    getJiraCloudSiteUrl: () => {
      const url = getString(settings, 'url')?.trim();
      return url && url.length > 0 ? url : base.getJiraCloudSiteUrl();
    },
    getJiraOAuthClientId: () => {
      const clientId = getString(settings, 'clientId')?.trim();
      return clientId && clientId.length > 0 ? clientId : base.getJiraOAuthClientId();
    },
    getJiraOAuthClientSecret: () => {
      if (secrets.oauthClientSecret && secrets.oauthClientSecret.trim().length > 0) {
        return secrets.oauthClientSecret;
      }
      const inline = getString(settings, 'oauthClientSecret')?.trim();
      return inline && inline.length > 0 ? inline : base.getJiraOAuthClientSecret();
    },

    // ── Jira Cloud compatibility keys ───────────────────────────────
    getJiraCloudBaseUrl: () => {
      const value = getString(settings, 'baseUrl')?.trim();
      return value && value.length > 0 ? value : base.getJiraCloudBaseUrl();
    },
    getJiraCloudToken: () => {
      if (secrets.jiraCloudToken && secrets.jiraCloudToken.trim().length > 0) {
        return secrets.jiraCloudToken;
      }
      const inline = getString(settings, 'token')?.trim();
      return inline && inline.length > 0 ? inline : base.getJiraCloudToken();
    },
    getJiraCloudEpicKey: () => getString(settings, 'epicKey')?.trim() ?? base.getJiraCloudEpicKey(),
    getJiraCloudEpicBoardName: () =>
      getString(settings, 'epicBoardName')?.trim() ?? base.getJiraCloudEpicBoardName(),
    getJiraCloudBoardJql: () => getString(settings, 'boardJql')?.trim() ?? base.getJiraCloudBoardJql(),
    getJiraCloudBoardName: () =>
      getString(settings, 'boardName')?.trim() ?? base.getJiraCloudBoardName(),

    // ── GitLab ───────────────────────────────────────────────────────
    getGitLabUrl: () => getString(settings, 'url')?.trim() ?? base.getGitLabUrl(),
    getGitLabApiKey: () => getString(settings, 'apiKey') ?? base.getGitLabApiKey(),
    getGitLabApiKeyFromSecrets: async (..._args: unknown[]): Promise<string> => {
      if (secrets.gitlabApiKey && secrets.gitlabApiKey.trim().length > 0) {
        return secrets.gitlabApiKey.trim();
      }
      const inline = getString(settings, 'apiKey')?.trim();
      return inline && inline.length > 0 ? inline : '';
    },
    getGitLabProjectPath: () =>
      getString(settings, 'projectPath') ?? base.getGitLabProjectPath(),
    getGitLabListAllAccessibleBoards: () =>
      getBoolean(settings, 'listAllAccessibleBoards') ?? base.getGitLabListAllAccessibleBoards(),
    getGitLabSelectedBoardRefs: () =>
      getStringArray(settings, 'selectedBoardRefs') ?? base.getGitLabSelectedBoardRefs(),

    // ── Live Folder ──────────────────────────────────────────────────
    getLiveFolderPath: () => getString(settings, 'path') ?? base.getLiveFolderPath(),
    getLiveFolderProjectKey: () =>
      getString(settings, 'projectKey') ?? base.getLiveFolderProjectKey(),
    getLiveFolderProjectName: () =>
      getString(settings, 'projectName') ?? base.getLiveFolderProjectName(),
    getLiveFolderAllowIssueCreation: () =>
      getBoolean(settings, 'allowIssueCreation') ?? base.getLiveFolderAllowIssueCreation(),

    // ── GitHub ───────────────────────────────────────────────────────
    getGitHubPat: () => {
      if (secrets.githubPat && secrets.githubPat.length > 0) {
        return secrets.githubPat;
      }
      return getString(settings, 'pat') ?? base.getGitHubPat();
    },
    getGitHubUrl: () => getString(settings, 'url') ?? base.getGitHubUrl(),
    getGitHubOwner: () => getString(settings, 'owner') ?? base.getGitHubOwner()
  };

  return new Proxy(base, {
    get(target, prop, _receiver): unknown {
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(overrides, prop)) {
        return overrides[prop];
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? (value as Function).bind(target) : value;
    }
  }) as AppConfigStore;
}

