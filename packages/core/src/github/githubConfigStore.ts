/**
 * Host-neutral config surface `GitHubBoardService` reads, mirroring
 * `GitLabConfigStore`'s shape. The desktop host satisfies it with an adapter
 * over a connection's `settings` record.
 */
export interface GitHubConfigStore {
  getDefaultPageSize(): number;
  /** API base URL — defaults to `https://api.github.com`; override for GitHub Enterprise Server. */
  getGitHubApiUrl(): string;
  getGitHubOwner(): string;
  getGitHubRepo(): string;
  /** Inline (non-secret-store) token; may be empty. */
  getGitHubApiKey(): string;
  /** Mirrors folder's `allowIssueCreation` gate — off by default. */
  getGitHubAllowIssueCreation(): boolean;
}

/** Optional host hooks for `GitHubBoardService`, mirroring `GitLabBoardServiceOptions`. */
export interface GitHubBoardServiceOptions {
  /**
   * Resolves the PAT from the host's secret store. Takes precedence over the
   * inline `getGitHubApiKey()` value when provided.
   */
  getApiKeyFromSecrets?: () => Promise<string>;
}
