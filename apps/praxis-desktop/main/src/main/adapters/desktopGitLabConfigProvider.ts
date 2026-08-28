import type { Connection, GitLabConfigStore } from '@praxis/core';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * `GitLabConfigStore` backed by a single desktop connection's `settings`
 * record (the same keys the extension's connection-scoped store maps). The
 * API key is resolved separately by the service registry through the
 * `getApiKeyFromSecrets` hook — secrets never live in `settings`.
 */
export class DesktopGitLabConfigProvider implements GitLabConfigStore {
  public constructor(private readonly connection: Connection) {}

  private get settings(): Record<string, unknown> {
    return isRecord(this.connection.settings) ? this.connection.settings : {};
  }

  public getDefaultPageSize(): number {
    const value = this.settings['defaultPageSize'];
    return typeof value === 'number' && Number.isFinite(value) ? value : 25;
  }

  public getGitLabUrl(): string {
    const value = this.settings['url'];
    return typeof value === 'string' ? value.trim() : '';
  }

  public getGitLabProjectPath(): string {
    const value = this.settings['projectPath'];
    return typeof value === 'string' ? value : '';
  }

  public getGitLabListAllAccessibleBoards(): boolean {
    return this.settings['listAllAccessibleBoards'] === true;
  }

  public getGitLabSelectedBoardRefs(): string[] {
    const value = this.settings['selectedBoardRefs'];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  }

  public getGitLabApiKey(): string {
    // Inline key fallback (the extension's scoped store supports the same).
    const value = this.settings['apiKey'];
    return typeof value === 'string' ? value : '';
  }
}
