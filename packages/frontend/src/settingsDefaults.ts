/**
 * Browser-safe mirror of the runtime values from `@ticket-manager/core`'s
 * `appSettings` module. The SettingsPage needs `DEFAULT_APP_SETTINGS`,
 * `PRIORITY_NAMES`, and `normalizePriorityColor` at runtime — but core is
 * CommonJS without `sideEffects: false` and depends on `chokidar` and
 * `markdown-it`, both of which touch `process` at module load. Vite/Rollup
 * cannot tree-shake that out of a renderer bundle, so we keep the source of
 * truth typed in core (for IPC + extension/main processes) and duplicate the
 * small, runtime-needed constants and the hex-color helper here. If the
 * defaults diverge from the core `DEFAULT_APP_SETTINGS`, the SettingsPage
 * will go out of sync with what the extension/main process see — keep them
 * identical.
 */

/** Parse `#rgb` or `#rrggbb` into components. Returns undefined if invalid.
 *  Duplicated locally to avoid importing `parseHexRgb` from core (which would
 *  drag the whole core package graph into the renderer). */
function parseHexRgb(input: string): { r: number; g: number; b: number } | undefined {
  let h = input.trim();
  if (!h.startsWith('#')) {
    return undefined;
  }
  h = h.slice(1);
  if (h.length === 3) {
    h = h
      .split('')
      .map(c => c + c)
      .join('');
  }
  if (h.length !== 6 || !/^[0-9a-fA-F]+$/.test(h)) {
    return undefined;
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  };
}

/** The six priority levels the appearance section customises. Order matters — UI renders top-down. */
export const PRIORITY_NAMES: readonly string[] = [
  'Critical',
  'Highest',
  'High',
  'Medium',
  'Low',
  'Lowest'
];

/** Defaults for the runtime Settings shape — keep in sync with `DEFAULT_APP_SETTINGS` in core. */
export const DEFAULT_APP_SETTINGS = {
  ai: {
    gatewayUrl: '',
    defaultModel: '',
    agentName: ''
  },
  jira: {
    siteUrl: '',
    defaultProjectKey: '',
    epicKey: '',
    epicBoardName: '',
    boardJql: '',
    boardName: ''
  },
  performance: {
    requestTimeoutMs: 30000,
    defaultPageSize: 25
  },
  delivery: {
    defaultBaseBranch: '',
    autoMergeSubTasks: true
  },
  mcpServer: {
    workspaceServerName: '',
    userServerRef: ''
  },
  preview: {
    enableCreateIdea: false,
    enableNewProject: false,
    boardsSidebarMode: 'classic' as 'classic' | 'work'
  },
  appearance: {
    showBrandArtwork: true,
    priorityColors: {
      Critical: '#DC2626',
      Highest: 'linear-gradient(to bottom, #DC2626, #EA580C)',
      High: '#F59E0B',
      Medium: 'linear-gradient(to bottom, #F59E0B, #3B82F6)',
      Low: 'linear-gradient(to bottom, #3B82F6, #22C55E)',
      Lowest: '#22C55E'
    }
  }
} as const;

/** Normalises a single priority color value — hex or `linear-gradient(...)`. */
export function normalizePriorityColor(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^linear-gradient\s*\(/.test(trimmed)) {
    return trimmed;
  }
  return parseHexRgb(trimmed) ? trimmed : undefined;
}
