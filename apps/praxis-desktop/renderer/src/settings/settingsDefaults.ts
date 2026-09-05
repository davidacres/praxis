/**
 * Browser-safe mirror of the runtime values from `@praxis/core`'s
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

/** Priority-colour map every fresh profile and every built-in Look starts from. Mirrors core. */
const DEFAULT_PRIORITY_COLORS = {
  Critical: '#DC2626',
  Highest: 'linear-gradient(to bottom, #DC2626, #EA580C)',
  High: '#F59E0B',
  Medium: 'linear-gradient(to bottom, #F59E0B, #3B82F6)',
  Low: 'linear-gradient(to bottom, #3B82F6, #22C55E)',
  Lowest: '#22C55E'
} as const;

/** One shipped Look — mirrors core's `builtInLook`; differ only by surface pack. */
function builtInLook(id: string, name: string, surfacePackId: string, motif?: { id: string; scale: number; opacity: number; ink: 'accent' | 'text' }) {
  return {
    id,
    name,
    themeId: 'praxis-dark',
    themeMode: 'dark' as 'light' | 'dark' | 'system',
    surfacePackId,
    surface: { intensity: 1, translucency: true, texture: true, windowVibrancy: false, animateMotifs: true, plainChatSurface: false, ...(motif ? { motif } : {}) },
    priorityColors: { ...DEFAULT_PRIORITY_COLORS } as Record<string, string>,
    showBrandArtwork: true
  };
}

/** The four Looks the strip is seeded with — keep in sync with core's `BUILT_IN_LOOKS`. */
export const BUILT_IN_LOOKS = [
  builtInLook('look-parchment', 'Parchment', 'parchment'),
  builtInLook('look-blueprint', 'Blueprint', 'parchment', { id: 'grid', scale: 104, opacity: 0.3, ink: 'accent' }),
  builtInLook('look-aurora', 'Aurora', 'aurora-glass'),
  builtInLook('look-flat', 'Flat', 'flat')
];

/** Defaults for the runtime Settings shape — keep in sync with `DEFAULT_APP_SETTINGS` in core. */
export const DEFAULT_APP_SETTINGS = {
  ai: {
    gatewayUrl: '',
    defaultModel: '',
    agentName: '',
    spendLimit: 0,
    browserTools: { enabled: false, allowedHosts: [] as string[] }
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
  startup: {
    reopenLastWorkspace: true
  },
  preview: {
    enableCreateIdea: false,
    enableNewProject: true,
    boardsSidebarMode: 'classic' as 'classic' | 'work'
  },
  appearance: {
    showBrandArtwork: true,
    themeId: 'praxis-dark',
    themeMode: 'dark' as 'light' | 'dark' | 'system',
    installedThemeIds: ['praxis-light', 'praxis-dark', 'tm-default-1', 'tm-default-2', 'humanist-light', 'humanist-dark', 'github-light', 'github-dark', 'jira-cloud', 'anthropic-light', 'anthropic-dark'] as string[],
    customThemes: [] as Array<{ id: string; name: string; mode: 'light' | 'dark'; description: string; preview: Record<string, string> }>,
    surfacePackId: 'parchment',
    surface: { intensity: 1, translucency: true, texture: true, windowVibrancy: false, animateMotifs: true, plainChatSurface: false },
    installedSurfacePackIds: ['flat', 'parchment', 'graphite', 'aurora-glass', 'noir'] as string[],
    customSurfacePacks: [] as Array<{ id: string; name: string; description: string; basePackId?: string; tokens: Record<string, string> }>,
    looks: BUILT_IN_LOOKS.map(look => ({ ...look, surface: { ...look.surface }, priorityColors: { ...look.priorityColors } })),
    activeLookId: 'look-parchment',
    priorityColors: { ...DEFAULT_PRIORITY_COLORS } as Record<string, string>
  },
  git: {
    executablePath: '',
    defaultBranch: '',
    fetchIntervalMinutes: 0
  },
  gitVisual: {
    branchColorsEnabled: true,
    mergeMarkersEnabled: true,
    orientation: 'vertical' as 'vertical' | 'horizontal',
    performanceMode: false
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
