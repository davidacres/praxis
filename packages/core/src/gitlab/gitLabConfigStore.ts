/**
 * Host-neutral slice of the extension's `AppConfigStore` that
 * `GitLabBoardService` reads. The extension satisfies it with its
 * `workspace.getConfiguration`-backed store (a structural superset); the
 * desktop host satisfies it with an adapter over a connection's `settings`
 * record.
 */
export interface GitLabConfigStore {
  getDefaultPageSize(): number;
  getGitLabUrl(): string;
  getGitLabProjectPath(): string;
  getGitLabListAllAccessibleBoards(): boolean;
  getGitLabSelectedBoardRefs(): string[];
  /** Inline (non-secret-store) API key; may be empty. */
  getGitLabApiKey(): string;
}

/** Optional host hooks for `GitLabBoardService`. */
export interface GitLabBoardServiceOptions {
  /**
   * Resolves the API key from the host's secret store. Takes precedence over
   * the inline `getGitLabApiKey()` value when provided (the extension's
   * per-connection path passes its SecretStorage lookup; the desktop host
   * passes its ConnectionStore secret lookup).
   */
  getApiKeyFromSecrets?: () => Promise<string>;
  /**
   * Workspace folder used to infer the GitLab project from the checked-out
   * repository when no project path is configured. Hosts without a workspace
   * concept (desktop v1) leave this unset and require a configured path.
   */
  getWorkspaceFolderPath?: () => string | undefined;
}
