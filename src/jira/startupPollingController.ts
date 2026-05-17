import { execFile as execFileCallback } from 'node:child_process';
import * as path from 'node:path';
import * as util from 'node:util';
import * as vscode from 'vscode';
import { AppConfigStore } from '../config/jiraConfig';
import type { ConnectionStore } from '../config/connectionStore';
import type { Connection } from '../types';

const execFile = util.promisify(execFileCallback);
const JIRA_POLLING_PREFIX = '[Jira Polling]';

interface PollingLogger {
  info(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

interface PollingConfig {
  BaseUrl?: string;
  Token?: string;
  LinkedEpicKey?: string;
  RequiredLabel?: string;
  RequiredStatus?: string;
}

interface PollingSyncEvent {
  /** Stable id of the connection (or `__global__` for legacy fallback) that emitted this event. */
  connectionId?: string;
  issues: Array<{
    key: string;
    fields?: {
      summary?: string;
      updated?: string;
      status?: {
        name?: string;
        statusCategory?: {
          name?: string;
        };
      };
    };
  }>;
  newKeys: string[];
  removedKeys: string[];
  changedKeys: string[];
  eligibleIssueKeys: string[];
}

function formatIssueKeyList(issueKeys: string[]): string {
  return issueKeys.length > 0 ? issueKeys.join(', ') : 'none';
}

interface PollingServiceInstance {
  start(options?: { once?: boolean; signal?: AbortSignal }): Promise<void>;
}

interface PollingModule {
  JiraPollingService: new (
    config: PollingConfig,
    options?: { logger?: PollingLogger; onSync?: (event: PollingSyncEvent) => Promise<void> | void }
  ) => PollingServiceInstance;
  getTokenOrThrow(config: PollingConfig): string;
  loadPollingConfig(configPath: string, overrides?: PollingConfig): PollingConfig;
}

interface ResolvedToken {
  source: 'process-environment' | 'windows-user-environment' | 'config';
  value?: string;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : util.inspect(error, { depth: 3 });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function readWindowsUserEnvironmentVariable(name: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile('reg.exe', ['query', String.raw`HKCU\Environment`, '/v', name], {
      windowsHide: true
    });
    const pattern = new RegExp(String.raw`^\s*${name}\s+REG_\w+\s+(.+)$`, 'mi');
    const match = pattern.exec(stdout);
    const value = match?.[1]?.trim();
    return value && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export class StartupPollingController implements vscode.Disposable {
  private readonly runs = new Map<string, RunState>();
  private hasShownSuccessNotification = false;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configStore: AppConfigStore,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly onSync?: (event: PollingSyncEvent) => Promise<void>,
    private readonly connectionStore?: ConnectionStore
  ) {}

  public async refresh(): Promise<void> {
    if (this.context.extensionMode === vscode.ExtensionMode.Test) {
      await this.stop();
      return;
    }
    if (!this.configStore.isJiraStartupPollingEnabled()) {
      await this.stop();
      return;
    }

    const targets = this.resolveTargets();
    const desiredIds = new Set(targets.map(t => t.id));

    // Stop runs whose target is gone or whose mode is no longer jiraapi.
    for (const [id, state] of this.runs) {
      if (!desiredIds.has(id)) {
        await this.stopRun(id, state);
      }
    }

    // Start/restart targets.
    for (const target of targets) {
      const runtimeKey = this.buildRuntimeKey(target);
      const existing = this.runs.get(target.id);
      if (existing?.runtimeKey === runtimeKey) {
        continue;
      }
      if (existing) {
        await this.stopRun(target.id, existing);
      }
      await this.startRun(target, runtimeKey);
    }
  }

  public async stop(): Promise<void> {
    const entries = [...this.runs.entries()];
    await Promise.all(entries.map(([id, state]) => this.stopRun(id, state)));
  }

  public dispose(): void {
    void this.stop();
  }

  /**
   * Resolve which jiraapi connections (if any) should be polled. When no
   * connections are configured, fall back to the legacy global jiraapi
   * settings so existing single-mode setups keep working.
   */
  private resolveTargets(): PollingTarget[] {
    const connections = this.connectionStore?.getConnections() ?? [];
    const jiraApi = connections.filter(c => c.mode === 'jiraapi');
    if (jiraApi.length > 0) {
      return jiraApi
        .map(c => this.connectionToTarget(c))
        .filter((t): t is PollingTarget => t !== undefined);
    }

    // Legacy fallback: single global config.
    if (
      this.configStore.getEffectiveBackendMode() !== 'jiraapi' ||
      this.configStore.getJiraApiEpicKey().trim().length === 0
    ) {
      return [];
    }
    return [
      {
        id: '__global__',
        label: 'global jiraapi config',
        baseUrl: this.configStore.getJiraApiBaseUrl(),
        token: this.configStore.getJiraApiToken(),
        epicKey: this.configStore.getJiraApiEpicKey()
      }
    ];
  }

  private connectionToTarget(connection: Connection): PollingTarget | undefined {
    const settings: Record<string, unknown> = connection.settings ?? {};
    const epicKey = typeof settings.epicKey === 'string' ? settings.epicKey.trim() : '';
    if (epicKey.length === 0) {
      return undefined;
    }
    const baseUrl = typeof settings.baseUrl === 'string' ? settings.baseUrl.trim() : undefined;
    const inlineToken = typeof settings.token === 'string' ? settings.token : undefined;
    return {
      id: connection.id,
      label: `${connection.name} (${connection.id})`,
      baseUrl: baseUrl && baseUrl.length > 0 ? baseUrl : undefined,
      // Token may be resolved later from SecretStorage; the resolveToken()
      // call also falls back to env vars.
      token: inlineToken,
      epicKey,
      connection
    };
  }

  private buildRuntimeKey(target: PollingTarget): string {
    return JSON.stringify({
      id: target.id,
      enabled: this.configStore.isJiraStartupPollingEnabled(),
      baseUrl: target.baseUrl,
      linkedEpicKey: target.epicKey,
      requiredLabel: this.configStore.getJiraPollingRequiredLabel()
    });
  }

  private async stopRun(id: string, state: RunState): Promise<void> {
    state.abortController.abort();
    await state.runPromise;
    this.runs.delete(id);
  }

  private async startRun(target: PollingTarget, runtimeKey: string): Promise<void> {
    try {
      const pollingModule = this.loadPollingModule();
      const configPath = this.context.asAbsolutePath(path.join('JiraPollingService', 'appsettings.json'));
      const overrides: PollingConfig = {
        LinkedEpicKey: target.epicKey,
        RequiredLabel: this.configStore.getJiraPollingRequiredLabel()
      };
      if (target.baseUrl) {
        overrides.BaseUrl = target.baseUrl;
      }
      const config = pollingModule.loadPollingConfig(configPath, overrides);

      const resolvedToken = await this.resolveToken(target);
      if (resolvedToken.value) {
        config.Token = resolvedToken.value;
      }

      try {
        pollingModule.getTokenOrThrow(config);
      } catch (error) {
        this.appendLine(`[${target.label}] Startup polling skipped: ${formatError(error)}`);
        return;
      }

      this.appendLine(
        `[${target.label}] Starting integrated poller using ${resolvedToken.source} for epic "${config.LinkedEpicKey}" with AI gate label "${config.RequiredLabel}" and status "${config.RequiredStatus}".`
      );

      const logger: PollingLogger = {
        info: (message, ...args) => {
          this.appendLine(`[${target.label}] ${util.format(message, ...args)}`);
          if (
            !this.hasShownSuccessNotification &&
            message === 'Poll complete. %d synced issue(s) currently found on epic %s. %d eligible for AI execution.' &&
            typeof args[0] === 'number'
          ) {
            this.hasShownSuccessNotification = true;
            void this.showSuccessNotification(args[0]);
          }
        },
        error: (message, ...args) => {
          this.appendLine(`[${target.label}] ${util.format(message, ...args)}`);
        }
      };

      const service = new pollingModule.JiraPollingService(config, {
        logger,
        onSync: async event => {
          this.logSyncEvent(target, event);
          await this.onSync?.({ ...event, connectionId: target.id });
        }
      });
      const abortController = new AbortController();
      const runPromise = service
        .start({ signal: abortController.signal })
        .catch(error => {
          if (!isAbortError(error)) {
            this.appendLine(`[${target.label}] Polling stopped unexpectedly: ${formatError(error)}`);
          }
        })
        .finally(() => {
          // If this is still the active runner for this id, clear it.
          const current = this.runs.get(target.id);
          if (current?.abortController === abortController) {
            this.runs.delete(target.id);
          }
        });
      this.runs.set(target.id, { runtimeKey, abortController, runPromise });
    } catch (error) {
      this.appendLine(`[${target.label}] Failed to start integrated poller: ${formatError(error)}`);
    }
  }

  private appendLine(message: string): void {
    this.outputChannel.appendLine(`${JIRA_POLLING_PREFIX} ${message}`);
  }

  private logSyncEvent(target: PollingTarget, event: PollingSyncEvent): void {
    const prefix = `[${target.label}]`;
    this.appendLine(
      `${prefix} Sync summary: ${event.issues.length} linked-epic issue(s), ${event.newKeys.length} new, ${event.changedKeys.length} changed, ${event.removedKeys.length} removed, ${event.eligibleIssueKeys.length} AI-eligible.`
    );

    if (event.newKeys.length > 0) {
      this.appendLine(`${prefix} New issues: ${formatIssueKeyList(event.newKeys)}`);
    }

    if (event.changedKeys.length > 0) {
      this.appendLine(`${prefix} Changed issues: ${formatIssueKeyList(event.changedKeys)}`);
    }

    if (event.removedKeys.length > 0) {
      this.appendLine(`${prefix} Removed issues: ${formatIssueKeyList(event.removedKeys)}`);
    }

    if (event.eligibleIssueKeys.length > 0) {
      this.appendLine(`${prefix} AI-eligible issues: ${formatIssueKeyList(event.eligibleIssueKeys)}`);
    }
  }

  private loadPollingModule(): PollingModule {
    const modulePath = this.context.asAbsolutePath(path.join('JiraPollingService', 'node', 'polling.js'));
    return require(modulePath) as PollingModule;
  }

  private async resolveToken(target: PollingTarget): Promise<ResolvedToken> {
    // Per-connection secret token wins when available.
    if (target.connection && this.connectionStore) {
      const secretToken = await this.connectionStore
        .getSecret(target.connection.id, 'jiraApiToken')
        .catch(() => undefined);
      if (secretToken && secretToken.trim().length > 0) {
        return { source: 'config', value: secretToken.trim() };
      }
    }
    if (target.token && target.token.trim().length > 0) {
      return { source: 'config', value: target.token.trim() };
    }

    const processToken = process.env.JIRA_TOKEN?.trim();
    const userToken =
      process.platform === 'win32'
        ? await readWindowsUserEnvironmentVariable('JIRA_TOKEN')
        : undefined;

    if (userToken && userToken !== processToken) {
      return {
        source: 'windows-user-environment',
        value: userToken
      };
    }

    if (processToken) {
      return {
        source: 'process-environment',
        value: processToken
      };
    }

    return {
      source: 'config'
    };
  }

  private async showSuccessNotification(issueCount: number): Promise<void> {
    const action = await vscode.window.showInformationMessage(
      `Jira background polling is active (${issueCount} matching issue${issueCount === 1 ? '' : 's'}).`,
      'Show Log'
    );

    if (action === 'Show Log') {
      this.outputChannel.show(true);
    }
  }
}

interface PollingTarget {
  /** Stable id for the runner — connection id, or `__global__` for legacy. */
  id: string;
  label: string;
  baseUrl?: string;
  token?: string;
  epicKey: string;
  connection?: Connection;
}

interface RunState {
  runtimeKey: string;
  abortController: AbortController;
  runPromise: Promise<void>;
}