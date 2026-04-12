import * as vscode from 'vscode';
import type { BackendMode } from '../types';
import { parseHexRgb } from '../ui/hexColor';

const DEFAULT_JIRA_BOARD_ICON = '#3b82f6';
const DEFAULT_DEMO_BOARD_ICON = '#a855f7';
const DEFAULT_FILE_BOARD_ICON = '#22c55e';
const DEFAULT_GITHUB_BOARD_ICON = '#6e5494';
const DEFAULT_GITLAB_BOARD_ICON = '#e24329';
const DEFAULT_LIVEFOLDER_BOARD_ICON = '#f59e0b';

/** Icon color for the board list / board panel header (matches Boards sidebar). */
export function resolveBackendModeBoardIconColor(mode: BackendMode): string {
  const cfg = vscode.workspace.getConfiguration('ticketManager');
  const key =
    mode === 'jira'
      ? 'jiraBoardListIconColor'
      : mode === 'demo'
        ? 'demoBoardListIconColor'
        : mode === 'livefolder' || mode === 'userworkspace'
          ? 'liveFolderBoardListIconColor'
          : 'fileBoardListIconColor';
  const custom = cfg.get<string>(key, '').trim();
  const parsed = parseHexRgb(custom);
  if (parsed) {
    const { r, g, b } = parsed;
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }
  switch (mode) {
    case 'jira':
      return DEFAULT_JIRA_BOARD_ICON;
    case 'demo':
      return DEFAULT_DEMO_BOARD_ICON;
    case 'file':
      return DEFAULT_FILE_BOARD_ICON;
    case 'github':
      return DEFAULT_GITHUB_BOARD_ICON;
    case 'gitlab':
      return DEFAULT_GITLAB_BOARD_ICON;
    case 'livefolder':
    case 'userworkspace':
      return DEFAULT_LIVEFOLDER_BOARD_ICON;
  }
}

/** SVG markup for the backend mode icon (same artwork as the Boards sidebar). */
export function boardListModeIconSvg(mode: BackendMode): string {
  switch (mode) {
    case 'jira':
      return '<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="3.2" cy="4.2" r="1.35" fill="currentColor"/><circle cx="10.8" cy="3" r="1.35" fill="currentColor"/><circle cx="7" cy="10.8" r="1.35" fill="currentColor"/><path d="M4.3 5.1l1.4 1.6M8.3 5.1L7 6.7M7 8.1V9.5" stroke="currentColor" fill="none" stroke-width="1.15" stroke-linecap="round"/></svg>';
    case 'demo':
      return '<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4.2 2.8v8.4l7.3-4.2-7.3-4.2z" fill="currentColor"/></svg>';
    case 'file':
      return '<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M3.5 1.5h4.2L10.5 4.3v8.2H3.5V1.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M7.7 1.5V4h2.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
    case 'github':
      return '<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M7 1.2A5.8 5.8 0 0 0 5.17 12.5c.29.05.4-.13.4-.28v-1c-1.62.35-1.96-.78-1.96-.78a1.54 1.54 0 0 0-.65-.85c-.53-.36.04-.35.04-.35a1.22 1.22 0 0 1 .9.6 1.24 1.24 0 0 0 1.7.48 1.24 1.24 0 0 1 .37-.78c-1.3-.15-2.66-.65-2.66-2.87a2.25 2.25 0 0 1 .6-1.56 2.09 2.09 0 0 1 .06-1.54s.49-.16 1.6.6a5.5 5.5 0 0 1 2.9 0c1.11-.75 1.6-.6 1.6-.6a2.09 2.09 0 0 1 .06 1.54 2.25 2.25 0 0 1 .6 1.56c0 2.23-1.36 2.72-2.66 2.86a1.39 1.39 0 0 1 .4 1.08v1.6c0 .19.1.34.4.28A5.8 5.8 0 0 0 7 1.2z" fill="currentColor"/></svg>';
    case 'gitlab':
      return '<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M7 12.6L9.1 6H4.9L7 12.6z" fill="currentColor"/><path d="M7 12.6L4.9 6H1.8L7 12.6z" fill="currentColor" opacity=".7"/><path d="M7 12.6l2.1-6.6h3.1L7 12.6z" fill="currentColor" opacity=".7"/><path d="M1.8 6l-.7 2.2c-.06.2.01.42.18.54L7 12.6 1.8 6z" fill="currentColor" opacity=".5"/><path d="M12.2 6l.7 2.2c.06.2-.01.42-.18.54L7 12.6 12.2 6z" fill="currentColor" opacity=".5"/></svg>';
    case 'livefolder':
    case 'userworkspace':
      return '<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 3.5h3.5l1 1.5H12v6H2V3.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 8h4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';
  }
}
