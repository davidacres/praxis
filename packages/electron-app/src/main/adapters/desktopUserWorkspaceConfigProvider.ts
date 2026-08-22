import type { Connection, UserWorkspaceConfigProvider } from '@ticket-manager/core';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * `UserWorkspaceConfigProvider` backed by a desktop connection's `settings`
 * record. Unset keys fall back to the extension's defaults (notably
 * `allowIssueCreation: true`, matching `AppConfigStore`).
 */
export class DesktopUserWorkspaceConfigProvider implements UserWorkspaceConfigProvider {
  public constructor(private readonly connection: Connection) {}

  private get settings(): Record<string, unknown> {
    return isRecord(this.connection.settings) ? this.connection.settings : {};
  }

  public getDefaultPageSize(): number {
    const value = this.settings['defaultPageSize'];
    return typeof value === 'number' && Number.isFinite(value) ? value : 25;
  }

  public getLiveFolderAllowIssueCreation(): boolean {
    const value = this.settings['allowIssueCreation'];
    return typeof value === 'boolean' ? value : true;
  }

  public getAiDefaultModel(): string {
    const value = this.settings['aiDefaultModel'];
    return typeof value === 'string' ? value : '';
  }
}
