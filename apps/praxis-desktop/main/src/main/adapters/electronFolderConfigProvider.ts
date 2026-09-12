import type { Connection, FolderConfigProvider } from '@praxis/core';

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

/**
 * Reads folder-connection settings from a connection's free-form `settings` bag
 * (`roots`, `projectKey`, `projectName`, `allowIssueCreation`).
 */
export class ElectronFolderConfigProvider implements FolderConfigProvider {
  public constructor(private readonly connection: Connection) {}

  public getDefaultPageSize(): number {
    return 25;
  }

  /**
   * `roots` is the current shape. A lone `path` string is still accepted so a
   * connection written before multi-root keeps resolving to one root.
   */
  public getFolderRoots(): string[] {
    const settings = this.settings();
    const roots = settings['roots'];
    if (Array.isArray(roots)) {
      return roots.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    }
    const legacyPath = getString(settings, 'path');
    return legacyPath && legacyPath.trim().length > 0 ? [legacyPath] : [];
  }

  public getFolderProjectKey(): string {
    return getString(this.settings(), 'projectKey') ?? '';
  }

  public getFolderProjectName(): string {
    return getString(this.settings(), 'projectName') ?? '';
  }

  public getFolderAllowIssueCreation(): boolean {
    return getBoolean(this.settings(), 'allowIssueCreation') ?? false;
  }

  public getAiDefaultModel(): string {
    return '';
  }

  /**
   * `buildProjectConnection` stamps every project-owned connection's settings
   * with `projectId` (see `projectConnection.ts`) — a plain user-added folder
   * connection never has one. That's the signal: only a folder-backed project
   * chose its key through the wizard, so only it should outrank whatever
   * `board.praxis.json` happens to already say.
   */
  public prefersConfiguredIdentity(): boolean {
    return typeof this.settings()['projectId'] === 'string';
  }

  private settings(): Record<string, unknown> {
    return isRecord(this.connection.settings) ? this.connection.settings : {};
  }
}
