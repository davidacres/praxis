import type { BackendMode, IssueTrackerService, LogSink } from '@ticket-manager/core';
import {
  GitLabBoardService,
  JiraMcpConnectionResolver,
  JiraService,
  LiveFolderService,
  StubBackendService,
  UserWorkspaceService
} from '@ticket-manager/core';
import { getConnectionStore } from './connectionStoreInstance';
import { getDemoService } from './demoServiceInstance';
import { getUserWorkspaceStore } from './userWorkspaceStoreInstance';
import { getLogBus } from './logBusInstance';
import { ElectronLiveFolderConfigProvider } from './adapters/electronLiveFolderConfigProvider';
import { DesktopJiraConfigProvider } from './adapters/desktopJiraConfigProvider';
import { DesktopGitLabConfigProvider } from './adapters/desktopGitLabConfigProvider';
import { DesktopUserWorkspaceConfigProvider } from './adapters/desktopUserWorkspaceConfigProvider';

const liveFolderServices = new Map<string, LiveFolderService>();
const jiraServices = new Map<string, JiraService>();
const gitLabServices = new Map<string, GitLabBoardService>();
const userWorkspaceServices = new Map<string, UserWorkspaceService>();
const stubServices = new Map<BackendMode, StubBackendService>();

/**
 * Backend sinks tee into the shared log bus (the Output panel's source) while
 * keeping their `[jira]`/`[gitlab]` prefixes on the console exactly as before.
 */
const consoleSink: LogSink = {
  appendLine: line => console.log(line)
};

const jiraLogSink: LogSink = getLogBus().tee('jira', consoleSink);

const gitLabLogSink: LogSink = getLogBus().tee('gitlab', consoleSink);

/**
 * Scopes a pre-registered Atlassian 3LO app needs for the remote MCP server
 * (per Atlassian's "bring your own OAuth client" guidance); `offline_access`
 * keeps refresh tokens flowing. Overridable per connection via
 * `jiraOAuthScope`.
 */
const DEFAULT_JIRA_OAUTH_SCOPE =
  'read:jira-work write:jira-work read:jira-user offline_access';

function getStubService(mode: BackendMode): StubBackendService {
  let stub = stubServices.get(mode);
  if (!stub) {
    stub = new StubBackendService(mode);
    stubServices.set(mode, stub);
  }
  return stub;
}

async function createJiraService(connectionId: string): Promise<IssueTrackerService> {
  const cached = jiraServices.get(connectionId);
  if (cached) {
    return cached;
  }

  const store = getConnectionStore();
  const connection = store.getConnection(connectionId);
  if (!connection) {
    return getStubService('jiracloud');
  }

  const provider = new DesktopJiraConfigProvider(connection, async patch => {
    const current = store.getConnection(connectionId);
    if (!current) {
      return;
    }
    await store.updateConnection({
      ...current,
      settings: { ...current.settings, ...patch }
    });
  });

  const resolver = new JiraMcpConnectionResolver(
    provider,
    provider,
    () => provider.getWorkspaceFolderPath()
  );

  let resolution;
  try {
    resolution = await resolver.resolve();
  } catch (error) {
    console.warn(
      `serviceRegistry — Jira MCP resolver failed for "${connectionId}": ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return getStubService('jiracloud');
  }

  if (!resolution) {
    return getStubService('jiracloud');
  }

  // API-token sign-in: the token lives in the safeStorage secrets store, never
  // in plain settings JSON — inject it as a Basic-auth header here. `allowOAuth`
  // is off for these connections (see DesktopJiraConfigProvider.getHttpAllowOAuth)
  // so a 401 surfaces as "bad token" instead of popping a browser.
  if (connection.settings['jiraAuthMethod'] === 'api-token' && resolution.config.type === 'http') {
    const email = String(connection.settings['jiraApiEmail'] ?? '').trim();
    const token = await store.getSecret(connectionId, 'jiraApiToken');
    if (!email || !token) {
      console.warn(
        `serviceRegistry — Jira API-token connection "${connectionId}" is missing its email or token`
      );
      return getStubService('jiracloud');
    }
    resolution.config.headers = {
      ...resolution.config.headers,
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
    };
  }

  // Bring-your-own OAuth app: when the connection carries a client id, the
  // OAuth provider skips dynamic registration and uses these credentials (the
  // secret rides along from the encrypted store, never settings JSON). This
  // is the path for orgs whose Atlassian site blocks DCR'd/unknown apps.
  if (resolution.config.type === 'http') {
    const clientId = String(connection.settings['jiraOAuthClientId'] ?? '').trim();
    if (clientId) {
      const clientSecret = (await store.getSecret(connectionId, 'jiraOAuthClientSecret'))?.trim();
      const redirectUrl = String(connection.settings['jiraOAuthRedirectUrl'] ?? '').trim();
      const scope =
        String(connection.settings['jiraOAuthScope'] ?? '').trim() || DEFAULT_JIRA_OAUTH_SCOPE;
      // Atlassian's MCP authorization server 500s on console-registered 3LO
      // client ids — BYO apps must authorize against auth.atlassian.com
      // directly. The endpoint keys are only for tests (e2e points them at a
      // mock); production connections leave them unset.
      const issuer =
        String(connection.settings['jiraOAuthIssuer'] ?? '').trim() || 'https://auth.atlassian.com';
      resolution.config.oauthClient = {
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
        ...(redirectUrl ? { redirectUrl } : {}),
        scope,
        // Atlassian's 3LO authorize endpoint mandates these; the DCR-managed
        // MCP client path doesn't, so only BYO connections carry them.
        extraAuthorizeParams: { audience: 'api.atlassian.com', prompt: 'consent' },
        authorizationServer: {
          issuer,
          authorizationEndpoint:
            String(connection.settings['jiraOAuthAuthorizationEndpoint'] ?? '').trim() ||
            `${issuer}/authorize`,
          tokenEndpoint:
            String(connection.settings['jiraOAuthTokenEndpoint'] ?? '').trim() ||
            `${issuer}/oauth/token`
        }
      };
    }
  }

  // Only successful resolutions are cached — a failure re-resolves on the next
  // call so starting the MCP server later doesn't require an app restart.
  const service = new JiraService(provider, jiraLogSink, resolution);
  jiraServices.set(connectionId, service);
  return service;
}

function createGitLabService(connectionId: string): IssueTrackerService {
  const cached = gitLabServices.get(connectionId);
  if (cached) {
    return cached;
  }

  const store = getConnectionStore();
  const connection = store.getConnection(connectionId);
  if (!connection) {
    return getStubService('gitlab');
  }

  const provider = new DesktopGitLabConfigProvider(connection);
  const service = new GitLabBoardService(
    provider,
    gitLabLogSink,
    globalThis.fetch,
    undefined,
    {
      // Preferred secret name first, then the legacy one, then the inline
      // settings key — same fallback chain as the extension's scoped store.
      getApiKeyFromSecrets: async () =>
        (await store.getSecret(connectionId, 'gitlabApiKey')) ??
        (await store.getSecret(connectionId, 'apiKey')) ??
        provider.getGitLabApiKey().trim()
    }
  );
  gitLabServices.set(connectionId, service);
  return service;
}

/**
 * Resolves the backend for a connectionId. `undefined` (the built-in demo
 * boards) and an unknown id resolve to the demo backend. A connection whose
 * mode has no desktop backend yet (github/userworkspace until their
 * ports land) — or a jiracloud connection whose MCP server can't be resolved —
 * resolves to a stub that reads empty and throws a clear message on mutation,
 * never silently to demo, which used to make a misconfigured connection
 * indistinguishable from demo data.
 */
export async function getServiceForConnection(
  connectionId: string | undefined
): Promise<IssueTrackerService> {
  if (!connectionId) {
    return getDemoService();
  }

  const connection = getConnectionStore().getConnection(connectionId);
  if (!connection) {
    console.warn(`serviceRegistry — unknown connection id "${connectionId}", using demo backend`);
    return getDemoService();
  }

  switch (connection.mode) {
    case 'demo':
      return getDemoService();
    case 'livefolder': {
      const cached = liveFolderServices.get(connectionId);
      if (cached) {
        return cached;
      }
      const service = new LiveFolderService(new ElectronLiveFolderConfigProvider(connection));
      liveFolderServices.set(connectionId, service);
      return service;
    }
    case 'jiracloud':
      return createJiraService(connectionId);
    case 'gitlab':
      return createGitLabService(connectionId);
    case 'userworkspace': {
      const cached = userWorkspaceServices.get(connectionId);
      if (cached) {
        return cached;
      }
      // The board store is app-global (mirrors the extension's globalState);
      // per-connection services differ only in the config provider.
      const service = new UserWorkspaceService(
        new DesktopUserWorkspaceConfigProvider(connection),
        getUserWorkspaceStore()
      );
      userWorkspaceServices.set(connectionId, service);
      return service;
    }
    default:
      return getStubService(connection.mode);
  }
}

/**
 * Connections that contribute boards to `board:list`. Demo is excluded because
 * the demo boards are always merged in unconditionally — including demo-mode
 * connections here would list the same demo boards once per connection.
 */
export function getSupportedConnections() {
  return getConnectionStore().getConnections().filter(c => c.mode !== 'demo');
}

/**
 * Drops the cached backend for a connection so the next resolution rebuilds it
 * from current settings/secrets. Called when a connection is updated, removed,
 * or has a secret changed.
 */
export function resetServiceForConnection(connectionId: string): void {
  const liveFolder = liveFolderServices.get(connectionId);
  liveFolder?.dispose();
  liveFolderServices.delete(connectionId);

  const jira = jiraServices.get(connectionId);
  if (jira) {
    jiraServices.delete(connectionId);
    void jira.reset();
  }

  const gitLab = gitLabServices.get(connectionId);
  if (gitLab) {
    gitLabServices.delete(connectionId);
    void gitLab.reset();
  }

  const userWorkspace = userWorkspaceServices.get(connectionId);
  if (userWorkspace) {
    userWorkspaceServices.delete(connectionId);
    userWorkspace.dispose();
  }
}

/**
 * Disposes every cached backend service (closing any live-folder/user-workspace
 * chokidar watchers in particular) so the app process can exit cleanly.
 *
 * Must run on `before-quit`, not just `window-all-closed` — on macOS closing
 * the last window doesn't quit the app, and a watcher left open otherwise
 * keeps the process alive past window close, hanging a graceful shutdown
 * (Electron/Node won't exit while an fs watcher — e.g. macOS FSEvents — is
 * still active).
 */
export function disposeAllServices(): void {
  for (const service of liveFolderServices.values()) {
    service.dispose();
  }
  liveFolderServices.clear();

  for (const service of userWorkspaceServices.values()) {
    service.dispose();
  }
  userWorkspaceServices.clear();

  for (const service of jiraServices.values()) {
    service.dispose();
  }
  jiraServices.clear();

  for (const service of gitLabServices.values()) {
    service.dispose();
  }
  gitLabServices.clear();
}
