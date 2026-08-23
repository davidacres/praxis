import { parseHexRgb } from '../ui/hexColor';
import type { AiProvider } from '../types';

/**
 * Typed settings shape shared between the Electron desktop app and the VS Code
 * extension. Stored as a single JSON document on disk at a platform-specific
 * path so both processes can read/write it; see
 * `resolveSharedSettingsPath` for the exact location.
 *
 * Sections mirror the Settings page's left-nav categories so a patch via
 * `mergeAppSettings` is a deep-merge and the UI updates one section at a time.
 *
 * Note: connection records (the `connections` and `boards` arrays) live in the
 * same file but are owned by `ConnectionStore`, not `AppSettings`. The keys
 * are kept separate so the new settings object doesn't collide on the existing
 * `connections` array key.
 */

export type BoardsSidebarMode = 'classic' | 'work';

/** The six priority levels the appearance section customises. Order matters — UI renders top-down. */
export const PRIORITY_NAMES: readonly string[] = [
  'Critical',
  'Highest',
  'High',
  'Medium',
  'Low',
  'Lowest'
];

export interface JiraSettings {
  /** Base URL of the Jira instance that MCP tools connect to. */
  siteUrl: string;
  /** Default Jira project key for new issues. */
  defaultProjectKey: string;
  /** Optional Epic key — boards follow this epic and Jira issue creation uses it as the default parent. */
  epicKey: string;
  /** Optional display name for the Jira MCP epic board. */
  epicBoardName: string;
  /** Optional Jira JQL query — when set, a JQL board is shown in addition to the epic board. */
  boardJql: string;
  /** Optional display name for the Jira MCP JQL board. */
  boardName: string;
}

export interface PerformanceSettings {
  /** Timeout, in milliseconds, for MCP requests. Min 1000. */
  requestTimeoutMs: number;
  /** Number of issues to request per page. Min 5, max 100. */
  defaultPageSize: number;
}

export interface DeliverySettings {
  /** Default base branch to use when a ticket does not specify one. Empty means the agent will ask. */
  defaultBaseBranch: string;
  /** When true (default), completed sub-task branches merge automatically into the feature branch. */
  autoMergeSubTasks: boolean;
  /** Master switch for the delivery workflow — the run action validates this first. */
  enabled: boolean;
  /** Repo-specific publish command the delivery agent must run (e.g. the MSI publish script). */
  publishCommand: string;
  /** Artifact path or glob the delivery agent must identify after publishing. */
  artifactPattern: string;
}

export interface McpServerSettings {
  /** Workspace MCP server name to use when Jira via MCP mode isn't manually configured. */
  workspaceServerName: string;
  /** User/profile MCP server reference to use when workspace MCP isn't selected. */
  userServerRef: string;
}

/** Non-secret per-provider config override. API keys never live here. */
export interface AiProviderConfig {
  /** `kind: 'api'` providers only — base URL override. */
  baseUrl?: string;
  /** `kind: 'api'` providers only — default model id override. */
  defaultModel?: string;
  /** `kind: 'cli-agent'` providers only — overrides the default PATH-resolved executable name. */
  cliPath?: string;
}

export interface AiSettings {
  /** Vercel AI Gateway base URL. Empty means default / env fallback. */
  gatewayUrl: string;
  /** Default model id (e.g. 'anthropic/claude-sonnet-4.6'). Empty means the service default. */
  defaultModel: string;
  /** Display name used for agent attribution (comments, commits). */
  agentName: string;
  /**
   * Default working directory for agent sessions (tool sandbox root, workflow-pack
   * discovery, delivery runs). Empty means the app's own directory.
   */
  workingDirectory: string;
  /** System prompt for issue analysis runs. Empty disables the analysis action. */
  analysisPrompt: string;
  /** When true, an issue must have a confirmed analysis before it can be delegated. */
  analysisGateEnabled: boolean;
  /** Which configured provider new sessions use by default. */
  activeProvider: AiProvider;
  /**
   * Per-provider non-secret config, keyed by provider id. `vercel-gateway`'s
   * effective config stays on the top-level `gatewayUrl`/`defaultModel`
   * fields above for backward compatibility — this map is for the other
   * providers only.
   */
  providers: Partial<Record<AiProvider, AiProviderConfig>>;
}

const KNOWN_AI_PROVIDERS: readonly AiProvider[] = [
  'vercel-gateway',
  'openai',
  'anthropic',
  'claude-code-cli',
  'codex-cli'
];

export interface PreviewSettings {
  /** Enable the Create Idea command and button (preview). */
  enableCreateIdea: boolean;
  /** Enable the New Project wizard (preview). */
  enableNewProject: boolean;
  /** Boards sidebar layout — 'classic' (separate views) or 'work' (board-centric). */
  boardsSidebarMode: BoardsSidebarMode;
}

export interface AppearanceSettings {
  /**
   * When true (default), the board list shows each backend's brand artwork
   * (Jira, GitLab, GitHub logos, …) as the board icon. When false, boards use
   * the generic per-board-type glyphs (Scrum/Kanban/Plan/…).
   */
  showBrandArtwork: boolean;
  /**
   * Color for each priority. Values are CSS: a 6-digit hex (`#rrggbb`, with or
   * without `#`) or a `linear-gradient(...)` expression. The shipped defaults use
   * both shapes.
   */
  priorityColors: Record<string, string>;
}

/** Top-level settings shape — one nested object per Settings-page category. */
export interface AppSettings {
  ai: AiSettings;
  jira: JiraSettings;
  performance: PerformanceSettings;
  delivery: DeliverySettings;
  mcpServer: McpServerSettings;
  preview: PreviewSettings;
  appearance: AppearanceSettings;
}

/** Shipped defaults — kept in sync with `package.json` contributes.configuration. */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  ai: {
    gatewayUrl: '',
    defaultModel: '',
    agentName: '',
    workingDirectory: '',
    analysisPrompt: '',
    analysisGateEnabled: false,
    activeProvider: 'vercel-gateway',
    providers: {}
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
    autoMergeSubTasks: true,
    enabled: false,
    publishCommand: '',
    artifactPattern: ''
  },
  mcpServer: {
    workspaceServerName: '',
    userServerRef: ''
  },
  preview: {
    enableCreateIdea: false,
    enableNewProject: false,
    boardsSidebarMode: 'classic'
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
};

/**
 * Deep-partial patch that callers send to `SettingsBackend.write`. Each
 * section is optional; nested sections merge key-by-key; priorityColors merges
 * per-key so a patch touching one priority doesn't reset the others.
 */
export interface AppSettingsPatch {
  ai?: Partial<AiSettings>;
  jira?: Partial<JiraSettings>;
  performance?: Partial<PerformanceSettings>;
  delivery?: Partial<DeliverySettings>;
  mcpServer?: Partial<McpServerSettings>;
  preview?: Partial<PreviewSettings>;
  appearance?: {
    showBrandArtwork?: boolean;
    priorityColors?: Record<string, string>;
  };
}

/** `true` when value is a plain object — guards against array/null confusion in the JSON loader. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A priority color value: either a `#rrggbb` hex (with/without `#`) or a `linear-gradient(...)` CSS expression. */
function isAcceptedColor(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (/^linear-gradient\s*\(/.test(trimmed)) {
    return true;
  }
  return Boolean(parseHexRgb(trimmed));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readBoardsSidebarMode(value: unknown, fallback: BoardsSidebarMode): BoardsSidebarMode {
  if (value === 'classic' || value === 'work') {
    return value;
  }
  return fallback;
}

function readAiProvider(value: unknown, fallback: AiProvider): AiProvider {
  return typeof value === 'string' && (KNOWN_AI_PROVIDERS as readonly string[]).includes(value)
    ? (value as AiProvider)
    : fallback;
}

function readAiProviderConfigs(value: unknown): Partial<Record<AiProvider, AiProviderConfig>> {
  if (!isRecord(value)) {
    return {};
  }
  const out: Partial<Record<AiProvider, AiProviderConfig>> = {};
  for (const id of KNOWN_AI_PROVIDERS) {
    const raw = value[id];
    if (!isRecord(raw)) {
      continue;
    }
    const config: AiProviderConfig = {};
    if (typeof raw.baseUrl === 'string' && raw.baseUrl.trim()) {
      config.baseUrl = raw.baseUrl;
    }
    if (typeof raw.defaultModel === 'string' && raw.defaultModel.trim()) {
      config.defaultModel = raw.defaultModel;
    }
    if (typeof raw.cliPath === 'string' && raw.cliPath.trim()) {
      config.cliPath = raw.cliPath;
    }
    if (Object.keys(config).length > 0) {
      out[id] = config;
    }
  }
  return out;
}

function readPriorityColors(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return { ...DEFAULT_APP_SETTINGS.appearance.priorityColors };
  }
  const next: Record<string, string> = {};
  for (const name of PRIORITY_NAMES) {
    const raw = value[name];
    if (typeof raw === 'string' && isAcceptedColor(raw)) {
      next[name] = raw.trim();
    } else {
      next[name] = DEFAULT_APP_SETTINGS.appearance.priorityColors[name]!;
    }
  }
  return next;
}

/**
 * Coerces an unknown JSON value into a valid `AppSettings`, filling any missing
 * or invalid fields from `DEFAULT_APP_SETTINGS`. Callers pass the parsed JSON
 * or an empty record on first launch; nothing throws.
 */
export function sanitizeAppSettings(raw: unknown): AppSettings {
  const ai: AiSettings = isRecord(raw) && isRecord(raw.ai)
    ? {
        gatewayUrl: readString(raw.ai.gatewayUrl, DEFAULT_APP_SETTINGS.ai.gatewayUrl),
        defaultModel: readString(raw.ai.defaultModel, DEFAULT_APP_SETTINGS.ai.defaultModel),
        agentName: readString(raw.ai.agentName, DEFAULT_APP_SETTINGS.ai.agentName),
        workingDirectory: readString(raw.ai.workingDirectory, DEFAULT_APP_SETTINGS.ai.workingDirectory),
        analysisPrompt: readString(raw.ai.analysisPrompt, DEFAULT_APP_SETTINGS.ai.analysisPrompt),
        analysisGateEnabled: readBoolean(
          raw.ai.analysisGateEnabled,
          DEFAULT_APP_SETTINGS.ai.analysisGateEnabled
        ),
        activeProvider: readAiProvider(raw.ai.activeProvider, DEFAULT_APP_SETTINGS.ai.activeProvider),
        providers: readAiProviderConfigs(raw.ai.providers)
      }
    : { ...DEFAULT_APP_SETTINGS.ai, providers: { ...DEFAULT_APP_SETTINGS.ai.providers } };

  const jira: JiraSettings = isRecord(raw) && isRecord(raw.jira)
    ? {
        siteUrl: readString(raw.jira.siteUrl, DEFAULT_APP_SETTINGS.jira.siteUrl),
        defaultProjectKey: readString(raw.jira.defaultProjectKey, DEFAULT_APP_SETTINGS.jira.defaultProjectKey),
        epicKey: readString(raw.jira.epicKey, DEFAULT_APP_SETTINGS.jira.epicKey),
        epicBoardName: readString(raw.jira.epicBoardName, DEFAULT_APP_SETTINGS.jira.epicBoardName),
        boardJql: readString(raw.jira.boardJql, DEFAULT_APP_SETTINGS.jira.boardJql),
        boardName: readString(raw.jira.boardName, DEFAULT_APP_SETTINGS.jira.boardName)
      }
    : { ...DEFAULT_APP_SETTINGS.jira };

  const performance: PerformanceSettings = isRecord(raw) && isRecord(raw.performance)
    ? {
        requestTimeoutMs: clampNumber(
          raw.performance.requestTimeoutMs,
          1000,
          Number.MAX_SAFE_INTEGER,
          DEFAULT_APP_SETTINGS.performance.requestTimeoutMs
        ),
        defaultPageSize: clampNumber(
          raw.performance.defaultPageSize,
          5,
          100,
          DEFAULT_APP_SETTINGS.performance.defaultPageSize
        )
      }
    : { ...DEFAULT_APP_SETTINGS.performance };

  const delivery: DeliverySettings = isRecord(raw) && isRecord(raw.delivery)
    ? {
        defaultBaseBranch: readString(raw.delivery.defaultBaseBranch, DEFAULT_APP_SETTINGS.delivery.defaultBaseBranch),
        autoMergeSubTasks: readBoolean(raw.delivery.autoMergeSubTasks, DEFAULT_APP_SETTINGS.delivery.autoMergeSubTasks),
        enabled: readBoolean(raw.delivery.enabled, DEFAULT_APP_SETTINGS.delivery.enabled),
        publishCommand: readString(raw.delivery.publishCommand, DEFAULT_APP_SETTINGS.delivery.publishCommand),
        artifactPattern: readString(raw.delivery.artifactPattern, DEFAULT_APP_SETTINGS.delivery.artifactPattern)
      }
    : { ...DEFAULT_APP_SETTINGS.delivery };

  const mcpServer: McpServerSettings = isRecord(raw) && isRecord(raw.mcpServer)
    ? {
        workspaceServerName: readString(
          raw.mcpServer.workspaceServerName,
          DEFAULT_APP_SETTINGS.mcpServer.workspaceServerName
        ),
        userServerRef: readString(raw.mcpServer.userServerRef, DEFAULT_APP_SETTINGS.mcpServer.userServerRef)
      }
    : { ...DEFAULT_APP_SETTINGS.mcpServer };

  const preview: PreviewSettings = isRecord(raw) && isRecord(raw.preview)
    ? {
        enableCreateIdea: readBoolean(raw.preview.enableCreateIdea, DEFAULT_APP_SETTINGS.preview.enableCreateIdea),
        enableNewProject: readBoolean(raw.preview.enableNewProject, DEFAULT_APP_SETTINGS.preview.enableNewProject),
        boardsSidebarMode: readBoardsSidebarMode(
          raw.preview.boardsSidebarMode,
          DEFAULT_APP_SETTINGS.preview.boardsSidebarMode
        )
      }
    : { ...DEFAULT_APP_SETTINGS.preview };

  const appearance: AppearanceSettings = isRecord(raw) && isRecord(raw.appearance)
    ? {
        showBrandArtwork: readBoolean(
          raw.appearance.showBrandArtwork,
          DEFAULT_APP_SETTINGS.appearance.showBrandArtwork
        ),
        priorityColors: readPriorityColors(raw.appearance.priorityColors)
      }
    : {
        showBrandArtwork: DEFAULT_APP_SETTINGS.appearance.showBrandArtwork,
        priorityColors: { ...DEFAULT_APP_SETTINGS.appearance.priorityColors }
      };

  return {
    ai,
    jira,
    performance,
    delivery,
    mcpServer,
    preview,
    appearance
  };
}

/** Merges per-provider config one level deep, so a patch touching one field of one provider doesn't drop its others. */
function mergeAiProviderConfigs(
  base: Partial<Record<AiProvider, AiProviderConfig>>,
  patch: Partial<Record<AiProvider, AiProviderConfig>>
): Partial<Record<AiProvider, AiProviderConfig>> {
  const out: Partial<Record<AiProvider, AiProviderConfig>> = { ...base };
  for (const id of KNOWN_AI_PROVIDERS) {
    const patchConfig = patch[id];
    if (patchConfig) {
      out[id] = { ...base[id], ...patchConfig };
    }
  }
  return out;
}

/** Deep-merge a patch over a base — returns a new object, never mutating inputs. */
export function mergeAppSettings(base: AppSettings, patch: AppSettingsPatch): AppSettings {
  const ai: AiSettings = {
    ...base.ai,
    ...(patch.ai ?? {}),
    providers: isRecord(patch.ai?.providers)
      ? mergeAiProviderConfigs(
          base.ai.providers,
          patch.ai!.providers as Partial<Record<AiProvider, AiProviderConfig>>
        )
      : base.ai.providers
  };

  const jira: JiraSettings = {
    ...base.jira,
    ...(patch.jira ?? {})
  };

  const performance: PerformanceSettings = {
    ...base.performance,
    ...(patch.performance ?? {})
  };

  const delivery: DeliverySettings = {
    ...base.delivery,
    ...(patch.delivery ?? {})
  };

  const mcpServer: McpServerSettings = {
    ...base.mcpServer,
    ...(patch.mcpServer ?? {})
  };

  const preview: PreviewSettings = {
    ...base.preview,
    ...(patch.preview ?? {})
  };

  const appearance: AppearanceSettings = {
    showBrandArtwork: patch.appearance?.showBrandArtwork ?? base.appearance.showBrandArtwork,
    priorityColors: isRecord(patch.appearance) && isRecord(patch.appearance.priorityColors)
      ? { ...base.appearance.priorityColors, ...patch.appearance.priorityColors }
      : { ...base.appearance.priorityColors }
  };

  return {
    ai,
    jira,
    performance,
    delivery,
    mcpServer,
    preview,
    appearance
  };
}

/** Normalises a single priority color value — strips whitespace; passes through hex or gradients. */
export function normalizePriorityColor(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!isAcceptedColor(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/** Pure helper — node-free — that returns the absolute path both hosts agree on for the shared settings file. */
export function resolveSharedSettingsPath(
  platform: string,
  env: { APPDATA?: string; XDG_CONFIG_HOME?: string; home: string }
): string {
  // Replicated locally to avoid pulling `node:path` into core type-only consumers.
  // Hosts always pass already-resolved segments, so a forward-slash join is OK
  // on Windows (VS Code/Electron both normalise separators internally).
  const join = (...parts: string[]): string =>
    parts
      .filter(p => p.length > 0)
      .join(platform === 'win32' ? '\\' : '/')
      .replace(/[\\/]+$/, '');

  if (platform === 'win32') {
    const base = env.APPDATA ?? join(env.home, 'AppData', 'Roaming');
    return join(base, 'ticket-manager', 'settings.json');
  }
  if (platform === 'darwin') {
    return join(env.home, 'Library', 'Application Support', 'ticket-manager', 'settings.json');
  }
  const base = env.XDG_CONFIG_HOME ?? join(env.home, '.config');
  return join(base, 'ticket-manager', 'settings.json');
}
