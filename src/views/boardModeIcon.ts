import * as vscode from 'vscode';
import type { BackendMode } from '../types';
import { parseHexRgb } from '../ui/hexColor';

const DEFAULT_JIRA_BOARD_ICON = '#3b82f6';
const DEFAULT_DEMO_BOARD_ICON = '#a855f7';
const DEFAULT_FILE_BOARD_ICON = '#22c55e';

/** Icon color for the board list / board panel header (matches Boards sidebar). */
export function resolveBackendModeBoardIconColor(mode: BackendMode): string {
  const cfg = vscode.workspace.getConfiguration('ticketManager');
  const key =
    mode === 'jira'
      ? 'jiraBoardListIconColor'
      : mode === 'demo'
        ? 'demoBoardListIconColor'
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
  }
}
