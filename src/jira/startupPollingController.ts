import { execFile as execFileCallback } from 'node:child_process';
import * as path from 'node:path';
import * as util from 'node:util';
import * as vscode from 'vscode';
import { AppConfigStore } from '../config/jiraConfig';

const execFile = util.promisify(execFileCallback);
const JIRA_POLLING_PREFIX = '[Jira Polling]';

interface PollingLogger {
  info(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

interface PollingConfig {
  Token?: string;
  LinkedEpicKey?: string;
  RequiredLabel?: string;
  RequiredStatus?: string;
}

interface PollingSyncEvent {
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
  private abortController: AbortController | undefined;
  private runPromise: Promise<void> | undefined;
  private activeRuntimeKey: string | undefined;
  private hasShownSuccessNotification = false;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configStore: AppConfigStore,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly onSync?: (event: PollingSyncEvent) => Promise<void>
  ) {}

  public async refresh(): Promise<void> {
    const shouldRun = this.shouldRun();
    if (!shouldRun) {
      await this.stop();
      return;
    }

    const runtimeKey = this.buildRuntimeKey();

    if (this.runPromise !== undefined && this.activeRuntimeKey === runtimeKey) {
      return;
    }

    if (this.runPromise !== undefined) {
      await this.stop();
    }

    await this.start(runtimeKey);
  }

  public async stop(): Promise<void> {
    const controller = this.abortController;
    const runPromise = this.runPromise;
    if (controller === undefined || runPromise === undefined) {
      return;
    }

    controller.abort();
    await runPromise;
  }

  public dispose(): void {
    void this.stop();
  }

  private shouldRun(): boolean {
    return (
      this.context.extensionMode !== vscode.ExtensionMode.Test &&
      this.configStore.isJiraStartupPollingEnabled() &&
      this.configStore.getEffectiveBackendMode() === 'jiraapi' &&
      this.configStore.getJiraApiEpicKey().trim().length > 0
    );
  }

  private buildRuntimeKey(): string {
    return JSON.stringify({
      backendMode: this.configStore.getEffectiveBackendMode(),
      enabled: this.configStore.isJiraStartupPollingEnabled(),
      linkedEpicKey: this.configStore.getJiraApiEpicKey(),
      requiredLabel: this.configStore.getJiraPollingRequiredLabel()
    });
  }

  private async start(runtimeKey: string): Promise<void> {
    try {
      const pollingModule = this.loadPollingModule();
      const configPath = this.context.asAbsolutePath(path.join('JiraPollingService', 'appsettings.json'));
      const config = pollingModule.loadPollingConfig(configPath, {
        LinkedEpicKey: this.configStore.getJiraApiEpicKey(),
        RequiredLabel: this.configStore.getJiraPollingRequiredLabel()
      });
      const resolvedToken = await this.resolveToken();
      if (resolvedToken.value) {
        config.Token = resolvedToken.value;
      }

      try {
        pollingModule.getTokenOrThrow(config);
      } catch (error) {
        this.appendLine(`Startup polling skipped: ${formatError(error)}`);
        return;
      }

      this.appendLine(
        `Starting integrated poller using ${resolvedToken.source} for epic "${config.LinkedEpicKey}" with AI gate label "${config.RequiredLabel}" and status "${config.RequiredStatus}".`
      );

      const logger: PollingLogger = {
        info: (message, ...args) => {
          this.appendLine(util.format(message, ...args));
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
          this.appendLine(util.format(message, ...args));
        }
      };

      const service = new pollingModule.JiraPollingService(config, {
        logger,
        onSync: async event => {
          this.logSyncEvent(event);
          await this.onSync?.(event);
        }
      });
      this.activeRuntimeKey = runtimeKey;
      this.abortController = new AbortController();
      this.runPromise = service
        .start({ signal: this.abortController.signal })
        .catch(error => {
          if (!isAbortError(error)) {
            this.appendLine(`Polling stopped unexpectedly: ${formatError(error)}`);
          }
        })
        .finally(() => {
          this.abortController = undefined;
          this.runPromise = undefined;
          this.activeRuntimeKey = undefined;
        });
    } catch (error) {
      this.activeRuntimeKey = undefined;
      this.appendLine(`Failed to start integrated poller: ${formatError(error)}`);
    }
  }

  private appendLine(message: string): void {
    this.outputChannel.appendLine(`${JIRA_POLLING_PREFIX} ${message}`);
  }

  private logSyncEvent(event: PollingSyncEvent): void {
    this.appendLine(
      `Sync summary: ${event.issues.length} linked-epic issue(s), ${event.newKeys.length} new, ${event.changedKeys.length} changed, ${event.removedKeys.length} removed, ${event.eligibleIssueKeys.length} AI-eligible.`
    );

    if (event.newKeys.length > 0) {
      this.appendLine(`New issues: ${formatIssueKeyList(event.newKeys)}`);
    }

    if (event.changedKeys.length > 0) {
      this.appendLine(`Changed issues: ${formatIssueKeyList(event.changedKeys)}`);
    }

    if (event.removedKeys.length > 0) {
      this.appendLine(`Removed issues: ${formatIssueKeyList(event.removedKeys)}`);
    }

    if (event.eligibleIssueKeys.length > 0) {
      this.appendLine(`AI-eligible issues: ${formatIssueKeyList(event.eligibleIssueKeys)}`);
    }
  }

  private loadPollingModule(): PollingModule {
    const modulePath = this.context.asAbsolutePath(path.join('JiraPollingService', 'node', 'polling.js'));
    return require(modulePath) as PollingModule;
  }

  private async resolveToken(): Promise<ResolvedToken> {
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