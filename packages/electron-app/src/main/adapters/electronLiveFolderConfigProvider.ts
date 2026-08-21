import type { Connection, LiveFolderConfigProvider } from '@ticket-manager/core';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(settings: Record<string, unknown>, key: string): string | undefined {
  const value = settings[key];
  return typeof value === 'string' ? value : undefined;
}

function getBoolean(settings: Record<string, unknown>, key: string): boolean | undefined {
  const value = settings[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** Reads Live Folder settings from a connection's free-form `settings` bag (`path`, `projectKey`, `projectName`, `allowIssueCreation`) — same keys the VS Code extension's connectionScopedConfigStore uses. */
export class ElectronLiveFolderConfigProvider implements LiveFolderConfigProvider {
  public constructor(private readonly connection: Connection) {}

  public getDefaultPageSize(): number {
    return 25;
  }

  public getLiveFolderPath(): string {
    return getString(this.settings(), 'path') ?? '';
  }

  public getLiveFolderProjectKey(): string {
    return getString(this.settings(), 'projectKey') ?? '';
  }

  public getLiveFolderProjectName(): string {
    return getString(this.settings(), 'projectName') ?? '';
  }

  public getLiveFolderAllowIssueCreation(): boolean {
    return getBoolean(this.settings(), 'allowIssueCreation') ?? false;
  }

  public getAiDefaultModel(): string {
    return '';
  }

  private settings(): Record<string, unknown> {
    return isRecord(this.connection.settings) ? this.connection.settings : {};
  }
}
