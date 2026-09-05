import type { Connection, GitHubConfigStore } from '@praxis/core';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * `GitHubConfigStore` backed by a single desktop connection's `settings`
 * record — mirrors `DesktopGitLabConfigProvider`. The PAT is resolved
 * separately by the service registry through the `getApiKeyFromSecrets` hook;
 * secrets never live in `settings`.
 */
export class DesktopGitHubConfigProvider implements GitHubConfigStore {
  public constructor(private readonly connection: Connection) {}

  private get settings(): Record<string, unknown> {
    return isRecord(this.connection.settings) ? this.connection.settings : {};
  }

  public getDefaultPageSize(): number {
    const value = this.settings['defaultPageSize'];
    return typeof value === 'number' && Number.isFinite(value) ? value : 25;
  }

  public getGitHubApiUrl(): string {
    const value = this.settings['url'];
    return typeof value === 'string' ? value.trim() : '';
  }

  public getGitHubOwner(): string {
    const value = this.settings['owner'];
    return typeof value === 'string' ? value : '';
  }

  public getGitHubRepo(): string {
    const value = this.settings['repo'];
    return typeof value === 'string' ? value : '';
  }

  public getGitHubApiKey(): string {
    // Inline token fallback (parity with GitLab's inline apiKey fallback).
    const value = this.settings['pat'];
    return typeof value === 'string' ? value : '';
  }

  public getGitHubAllowIssueCreation(): boolean {
    return this.settings['allowIssueCreation'] === true;
  }
}
