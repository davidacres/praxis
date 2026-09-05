import type { BackendMode, Connection, TrackedBoard } from '@praxis/core';

/**
 * Connection-mode policy for the desktop connections manager. Mirrors the
 * extension's `connectionsManagerPanel` rules so both hosts write the same
 * shape into the shared settings file. Pure functions only — the frontend
 * deliberately imports just *types* from `@praxis/core` (a runtime
 * import would drag node-only services into the renderer bundle).
 */

/** Modes offered in the "new connection" dropdown, in display order. */
export const CONNECTION_MODES: readonly BackendMode[] = [
  'demo',
  'folder',
  'jiracloud',
  'gitlab',
  'github'
];

/**
 * Secret field names per mode. Secrets go through `connection:setSecret` (OS
 * keychain), never into `connection.settings` / settings.json. The list also
 * drives the per-connection purge when a connection is removed — every name
 * declared here is dropped from the OS keychain at remove time, so a
 * forgotten API-token secret cannot outlive its connection.
 */
export function secretNamesForMode(mode: BackendMode): readonly string[] {
  switch (mode) {
    case 'gitlab':
      return ['apiKey'];
    case 'github':
      return ['pat'];
    case 'jiracloud':
      return ['jiraApiToken', 'jiraOAuthClientSecret'];
    default:
      return [];
  }
}

/**
 * Modes whose single canonical board is derived from the connection itself —
 * saving the connection upserts this synthesized tracked board (and prunes any
 * others) instead of opening the board picker.
 */
export function autoSynthesizesBoard(mode: BackendMode): boolean {
  return mode === 'folder' || mode === 'demo' || mode === 'github';
}

/** Modes with discoverable remote boards the user tracks via the board picker. */
export function supportsManualBoardSelection(mode: BackendMode): boolean {
  return mode === 'jiracloud' || mode === 'gitlab';
}

export function stringSetting(connection: Connection, key: string): string | undefined {
  const value = connection.settings?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The tracked board a demo/folder/github connection owns by construction. The
 * id must match what each backend's own `getBoards()` emits — `folder-<projectKey>`
 * for folder's primary root, `github:<owner>/<repo>` for GitHub's one board per
 * repository — so the manager's tracked list and the sidebar's board list agree.
 * A folder connection with several roots exposes the extra boards through
 * `getBoards()` — only the primary one is tracked here. GitHub returns
 * `undefined` until both owner and repo are set, matching folder's fallback
 * defaults being always-present (so folder never returns undefined) while
 * GitHub genuinely has nothing to synthesize yet.
 */
export function createSynthesizedTrackedBoard(connection: Connection): TrackedBoard | undefined {
  if (connection.mode === 'folder') {
    const projectKey = stringSetting(connection, 'projectKey') ?? 'LIVE';
    const projectName = stringSetting(connection, 'projectName') ?? 'Folder';
    return {
      connectionId: connection.id,
      boardId: `folder-${projectKey.toLowerCase()}`,
      displayName: projectName
    };
  }
  if (connection.mode === 'demo') {
    return {
      connectionId: connection.id,
      boardId: connection.id,
      displayName: connection.name
    };
  }
  if (connection.mode === 'github') {
    const owner = stringSetting(connection, 'owner');
    const repo = stringSetting(connection, 'repo');
    if (!owner || !repo) {
      return undefined;
    }
    return {
      connectionId: connection.id,
      boardId: `github:${owner}/${repo}`,
      displayName: `${owner}/${repo}`
    };
  }
  return undefined;
}
