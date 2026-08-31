import type { BackendMode, Board } from '@praxis/core';
import type { IconName } from '../ui/Icon';

/**
 * Board presentation metadata, mirroring what the VS Code extension shows today:
 * a per-backend glyph and brand tone for the connection, and a per-board-type
 * glyph for the board itself.
 */

/** Board.type is an open string — each backend picks its own vocabulary. */
export type BoardTypeToken = 'scrum' | 'kanban' | 'epic' | 'jql' | 'plan' | 'board';

const BOARD_TYPE_ICONS: Record<BoardTypeToken, IconName> = {
  scrum: 'target',
  kanban: 'columns',
  epic: 'rocket',
  jql: 'search',
  plan: 'milestone',
  board: 'columns'
};

const BOARD_TYPE_LABELS: Record<BoardTypeToken, string> = {
  scrum: 'Scrum',
  kanban: 'Kanban',
  epic: 'Epic',
  jql: 'JQL',
  plan: 'Plan',
  board: 'Board'
};

/**
 * Collapses the open `Board.type` string onto the tokens we render, including
 * the `plan` bucket the folder backend emits.
 */
export function boardTypeToken(board: Pick<Board, 'type' | 'id'>): BoardTypeToken {
  const normalized = board.type?.trim().toLowerCase();
  switch (normalized) {
    case 'scrum':
    case 'kanban':
    case 'epic':
    case 'jql':
    case 'plan':
      return normalized;
    default:
      break;
  }
  // Fall back to the id prefixes the extension's `inferBoardType` keys off.
  if (board.id?.startsWith('epic:')) {
    return 'epic';
  }
  if (board.id?.startsWith('jql:') || board.id?.startsWith('jql-custom:')) {
    return 'jql';
  }
  if (board.id?.startsWith('folder-')) {
    return 'plan';
  }
  return 'board';
}

export function boardTypeIcon(board: Pick<Board, 'type' | 'id'>): IconName {
  return BOARD_TYPE_ICONS[boardTypeToken(board)];
}

export function boardTypeLabel(board: Pick<Board, 'type' | 'id'>): string {
  return BOARD_TYPE_LABELS[boardTypeToken(board)];
}

export interface BackendModeMeta {
  label: string;
  icon: IconName;
  /** CSS custom property carrying the backend's brand tone. */
  tone: string;
}

export const BACKEND_MODE_META: Record<BackendMode, BackendModeMeta> = {
  jiracloud: { label: 'Jira', icon: 'organization', tone: 'var(--tone-jira)' },
  demo: { label: 'Demo', icon: 'dot', tone: 'var(--tone-demo)' },
  github: { label: 'GitHub', icon: 'git-branch', tone: 'var(--tone-github)' },
  gitlab: { label: 'GitLab', icon: 'git-branch', tone: 'var(--tone-gitlab)' },
  folder: { label: 'Folder', icon: 'folder', tone: 'var(--tone-folder)' },
  project: { label: 'Project', icon: 'target', tone: 'var(--tone-workspace)' },
  userworkspace: { label: 'User Workspace', icon: 'folder-open', tone: 'var(--tone-workspace)' }
};

export function backendModeMeta(mode: BackendMode | undefined): BackendModeMeta {
  return mode ? BACKEND_MODE_META[mode] : BACKEND_MODE_META.demo;
}

/** Connection-id prefix for a project's synthetic connection (`projectConnectionId` in core). */
export const PROJECT_CONNECTION_PREFIX = 'project:';

/**
 * The backend mode behind a board's `connectionId`.
 *
 * A project's board is reached through the synthetic `project:<id>` id, which
 * has no row in the connection store — looking it up there yields `undefined`
 * and used to fall back to `demo`, so project boards were driven by demo's
 * field rules. Resolve the prefix first.
 */
export function resolveBackendMode(
  connectionId: string | undefined,
  connections: ReadonlyArray<{ id: string; mode: BackendMode }>
): BackendMode {
  if (connectionId?.startsWith(PROJECT_CONNECTION_PREFIX)) {
    return 'project';
  }
  return connections.find(connection => connection.id === connectionId)?.mode ?? 'demo';
}

/** Maps a Jira-style status category onto a tone for column dots and badges. */
export function statusTone(statusCategory: string | undefined, status: string): string {
  const value = (statusCategory ?? status).toLowerCase();
  if (value.includes('done') || value.includes('complete')) {
    return 'var(--tone-green)';
  }
  if (value.includes('progress') || value.includes('indeterminate')) {
    return 'var(--tone-amber)';
  }
  if (value.includes('block')) {
    return 'var(--tone-red)';
  }
  return 'var(--text-tertiary)';
}
