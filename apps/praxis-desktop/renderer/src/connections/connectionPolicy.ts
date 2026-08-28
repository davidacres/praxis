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
  'livefolder',
  'jiracloud',
  'gitlab',
  'userworkspace',
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
  return mode === 'livefolder' || mode === 'demo';
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
 * The tracked board a demo/livefolder connection owns by construction. The id
 * matches what the backend's `getBoards()` emits (`livefolder-<projectKey>`),
 * so the manager's tracked list and the sidebar's board list agree; it is also
 * what the VS Code extension writes for the same connection in the shared
 * settings file.
 */
export function createSynthesizedTrackedBoard(connection: Connection): TrackedBoard | undefined {
  if (connection.mode === 'livefolder') {
    const projectKey = stringSetting(connection, 'projectKey') ?? 'LIVE';
    const projectName = stringSetting(connection, 'projectName') ?? 'Live Folder';
    return {
      connectionId: connection.id,
      boardId: `livefolder-${projectKey.toLowerCase()}`,
      displayName: `${projectName} (Live)`
    };
  }
  if (connection.mode === 'demo') {
    return {
      connectionId: connection.id,
      boardId: connection.id,
      displayName: connection.name
    };
  }
  return undefined;
}
