import * as vscode from 'vscode';
import type { BackendMode } from '@praxis/core';
import { parseHexRgb } from '@praxis/core';

const DEFAULT_JIRA_BOARD_ICON = '#3b82f6';
const DEFAULT_DEMO_BOARD_ICON = '#a855f7';
const DEFAULT_GITHUB_BOARD_ICON = '#6e5494';
const DEFAULT_GITLAB_BOARD_ICON = '#e24329';
const DEFAULT_LIVEFOLDER_BOARD_ICON = '#f59e0b';

/** Icon color for the board list / board panel header (matches Boards sidebar). */
export function resolveBackendModeBoardIconColor(mode: BackendMode): string {
  const cfg = vscode.workspace.getConfiguration('praxis');
  const key =
    mode === 'jiracloud'
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
    case 'jiracloud':
      return DEFAULT_JIRA_BOARD_ICON;
    case 'demo':
      return DEFAULT_DEMO_BOARD_ICON;
    case 'github':
      return DEFAULT_GITHUB_BOARD_ICON;
    case 'gitlab':
      return DEFAULT_GITLAB_BOARD_ICON;
    case 'livefolder':
    case 'userworkspace':
      return DEFAULT_LIVEFOLDER_BOARD_ICON;
  }

  return DEFAULT_LIVEFOLDER_BOARD_ICON;
}

/** SVG markup for the backend mode icon (same artwork as the Boards sidebar). */
export function boardListModeIconSvg(mode: BackendMode): string {
  switch (mode) {
    case 'jiracloud':
      return '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M30.2 0H15.6C15.6 3.6 18.5 6.6 22.1 6.6H24.7V9.2C24.7 12.8 27.6 15.8 31.2 15.8V1C31.2 0.4 30.8 0 30.2 0Z" fill="#0052CC"/><path d="M22.1 8H7.5C7.5 11.6 10.4 14.6 14 14.6H16.6V17.2C16.6 20.8 19.5 23.8 23.1 23.8V9C23.1 8.4 22.7 8 22.1 8Z" fill="url(#paint0_linear)"/><path d="M14 16H0C0 19.6 2.9 22.6 6.5 22.6H9.1V25.2C9.1 28.8 12 31.8 15.6 31.8V17C15.6 16.4 15.2 16 14 16Z" fill="url(#paint1_linear)"/><defs><linearGradient id="paint0_linear" x1="22.9" y1="9.5" x2="16.4" y2="16.7" gradientUnits="userSpaceOnUse"><stop offset="0.18" stop-color="#0052CC"/><stop offset="1" stop-color="#2684FF"/></linearGradient><linearGradient id="paint1_linear" x1="14.2" y1="16.9" x2="7.7" y2="24.2" gradientUnits="userSpaceOnUse"><stop offset="0.18" stop-color="#0052CC"/><stop offset="1" stop-color="#2684FF"/></linearGradient></defs></svg>';
    case 'demo':
      return '<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4.2 2.8v8.4l7.3-4.2-7.3-4.2z" fill="currentColor"/></svg>';
    case 'github':
      return '<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M7 1.2A5.8 5.8 0 0 0 5.17 12.5c.29.05.4-.13.4-.28v-1c-1.62.35-1.96-.78-1.96-.78a1.54 1.54 0 0 0-.65-.85c-.53-.36.04-.35.04-.35a1.22 1.22 0 0 1 .9.6 1.24 1.24 0 0 0 1.7.48 1.24 1.24 0 0 1 .37-.78c-1.3-.15-2.66-.65-2.66-2.87a2.25 2.25 0 0 1 .6-1.56 2.09 2.09 0 0 1 .06-1.54s.49-.16 1.6.6a5.5 5.5 0 0 1 2.9 0c1.11-.75 1.6-.6 1.6-.6a2.09 2.09 0 0 1 .06 1.54 2.25 2.25 0 0 1 .6 1.56c0 2.23-1.36 2.72-2.66 2.86a1.39 1.39 0 0 1 .4 1.08v1.6c0 .19.1.34.4.28A5.8 5.8 0 0 0 7 1.2z" fill="currentColor"/></svg>';
    case 'gitlab':
      return '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><title>file_type_gitlab</title><polygon points="16 28.896 16 28.896 21.156 13.029 10.844 13.029 16 28.896" style="fill:#e24329"></polygon><polygon points="16 28.896 10.844 13.029 3.619 13.029 16 28.896" style="fill:#fc6d26"></polygon><path d="M3.619,13.029h0L2.052,17.851a1.067,1.067,0,0,0,.388,1.193L16,28.9,3.619,13.029Z" style="fill:#fca326"></path><path d="M3.619,13.029h7.225L7.739,3.473a.534.534,0,0,0-1.015,0L3.619,13.029Z" style="fill:#e24329"></path><polygon points="16 28.896 21.156 13.029 28.381 13.029 16 28.896" style="fill:#fc6d26"></polygon><path d="M28.381,13.029h0l1.567,4.822a1.067,1.067,0,0,1-.388,1.193L16,28.9,28.381,13.029Z" style="fill:#fca326"></path><path d="M28.381,13.029H21.156l3.105-9.557a.534.534,0,0,1,1.015,0l3.105,9.557Z" style="fill:#e24329"></path></svg>';
    case 'livefolder':
    case 'userworkspace':
      return '<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 3.5h3.5l1 1.5H12v6H2V3.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 8h4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';
  }

  return '<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 3.5h3.5l1 1.5H12v6H2V3.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 8h4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';
}

