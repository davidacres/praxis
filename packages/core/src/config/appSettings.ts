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
  /**
   * Curated subset of the provider's fetched model catalog to offer in the
   * composer's per-session Model picker (Settings → AI Provider → Models).
   * `undefined` means "no curation yet — offer the whole catalog", not "none
   * enabled"; an explicit `[]` means the user unchecked everything. Applies
   * to every provider uniformly, including `vercel-gateway` — unlike
   * `baseUrl`/`defaultModel`, this field has no legacy top-level equivalent.
   */
  enabledModelIds?: string[];
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
  'codex-cli',
  'copilot-cli'
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
  /** Selected named UI theme. The renderer validates the id against its gallery. */
  themeId: string;
  /** Whether the selected theme follows an explicit or system appearance mode. */
  themeMode: 'light' | 'dark' | 'system';
  /** Marketplace themes explicitly installed into this profile. */
  installedThemeIds: string[];
  /** User-created themes stored in the shared settings document. */
  customThemes: Array<{
    id: string;
    name: string;
    mode: 'light' | 'dark';
    description: string;
    preview: Record<string, string>;
  }>;
  /**
   * Active surface pack — the premium texture / material layer composed *over*
   * the theme (it never defines colour). Composes with `themeId`/`themeMode`.
   * Ships `'parchment'`; `'flat'` is the inert opt-out.
   */
  surfacePackId: string;
  /** User dials that scale the active surface pack. */
  surface: {
    /** 0..1 multiplier on texture strength and glow. */
    intensity: number;
    /** Gate the translucency / backdrop-blur path (phase 2+). */
    translucency: boolean;
    /** Gate the texture / grain layers. */
    texture: boolean;
    /** Opt in to native OS window vibrancy (phase 3+). */
    windowVibrancy: boolean;
    /**
     * The user's Motif override. The motif (hexagon, grid, weave …) is
     * independent of the material, so it can be worn over any theme *and* any
     * pack. Fields left out fall back to the active pack's own pattern, so a
     * partial override — just a colour, say — still works.
     */
    motif?: SurfaceMotifSettings;
  };
  /** Surface packs available in this profile (built-ins are always present). */
  installedSurfacePackIds: string[];
  /** User-created surface packs stored in the shared settings document. */
  customSurfacePacks: Array<{
    id: string;
    name: string;
    description: string;
    /** Optional built-in pack to inherit tokens from before applying overrides. */
    basePackId?: string;
    /** `--surface-*` custom-property overrides; validated against a whitelist. */
    tokens: Record<string, string>;
    /**
     * Watermark pattern chosen from the renderer's shared pattern library
     * (`surfacePatterns.ts`) by id. Held as data so adding a material never
     * needs new CSS; the renderer ignores ids it does not know.
     */
    pattern?: SurfaceMotifSettings;
  }>;
}

/**
 * A watermark motif: which pattern from the renderer's library, how it is
 * placed, and the material properties the user can tune. Shared by a custom
 * pack's own pattern and by the profile-wide `surface.motif` override.
 */
export interface SurfaceMotifSettings {
  /** Pattern id from the renderer's library; unknown ids are ignored there. */
  id: string;
  /** Size of one cell in CSS pixels. */
  scale: number;
  /** 0..1 strength, before the user's Intensity dial. */
  opacity: number;
  /** Which live theme token tints it, or `custom` to use `inkColor`. */
  ink?: 'accent' | 'text' | 'custom';
  /** Explicit colour when `ink` is `custom`. */
  inkColor?: string;
  /** Stroke weight, relative to one cell. */
  weight?: number;
  blend?: string;
  /** `tile` repeats everywhere; `corner` is one anchored, fading motif. */
  placement?: 'tile' | 'corner';
  /** Which window corner a `corner` motif grows from. */
  anchor?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** How far a `corner` motif spreads, in CSS pixels. */
  spread?: number;
  /** 0..1 — how far across the spread it fades to nothing. */
  fade?: number;
  /** 0..1 density of solid cells scattered through the lattice. */
  fill?: number;
  /** 0..1 strength of a second offset line behind the main one (letterpress edge). */
  outline?: number;
  /** Colour of that offset line; defaults to a mode-appropriate tone. */
  outlineInk?: string;
}

export type TerminalCursorStyle = 'block' | 'underline' | 'bar';

export interface TerminalSettings {
  /** Profile id used when creating a terminal without an explicit selection. */
  defaultProfileId: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  copyOnSelection: boolean;
  confirmPaste: boolean;
  bellSound: boolean;
  shellIntegration: boolean;
  gpuAcceleration: boolean;
}

export interface GitSettings {
  executablePath: string;
  defaultBranch: string;
  fetchIntervalMinutes: number;
}

export interface GitVisualSettings {
  branchColorsEnabled: boolean;
  mergeMarkersEnabled: boolean;
  orientation: 'vertical' | 'horizontal';
  performanceMode: boolean;
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
  terminal: TerminalSettings;
  git: GitSettings;
  gitVisual: GitVisualSettings;
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
    enableNewProject: true,
    boardsSidebarMode: 'classic'
  },
  appearance: {
    showBrandArtwork: true,
    themeId: 'praxis-dark',
    themeMode: 'dark',
    installedThemeIds: ['praxis-light', 'praxis-dark', 'tm-default-1', 'tm-default-2', 'humanist-light', 'humanist-dark', 'github-light', 'github-dark', 'anthropic-light', 'anthropic-dark'],
    customThemes: [],
    surfacePackId: 'parchment',
    surface: { intensity: 1, translucency: true, texture: true, windowVibrancy: false },
    installedSurfacePackIds: ['flat', 'parchment', 'graphite', 'blueprint', 'aurora-glass', 'noir'],
    customSurfacePacks: [],
    priorityColors: {
      Critical: '#DC2626',
      Highest: 'linear-gradient(to bottom, #DC2626, #EA580C)',
      High: '#F59E0B',
      Medium: 'linear-gradient(to bottom, #F59E0B, #3B82F6)',
      Low: 'linear-gradient(to bottom, #3B82F6, #22C55E)',
      Lowest: '#22C55E'
    }
  },
  terminal: {
    defaultProfileId: '',
    fontFamily: "Menlo, Monaco, 'SF Mono', 'Courier New', monospace",
    fontSize: 13,
    lineHeight: 1.1,
    cursorStyle: 'block',
    cursorBlink: true,
    scrollback: 5000,
    copyOnSelection: false,
    confirmPaste: true,
    bellSound: false,
    shellIntegration: true,
    gpuAcceleration: true
  },
  git: {
    executablePath: '',
    defaultBranch: '',
    fetchIntervalMinutes: 0
  },
  gitVisual: {
    branchColorsEnabled: true,
    mergeMarkersEnabled: true,
    orientation: 'vertical',
    performanceMode: false
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
    themeId?: string;
    themeMode?: 'light' | 'dark' | 'system';
    installedThemeIds?: string[];
    customThemes?: AppearanceSettings['customThemes'];
    surfacePackId?: string;
    surface?: Partial<AppearanceSettings['surface']>;
    installedSurfacePackIds?: string[];
    customSurfacePacks?: AppearanceSettings['customSurfacePacks'];
  };
  terminal?: Partial<TerminalSettings>;
  git?: Partial<GitSettings>;
  gitVisual?: Partial<GitVisualSettings>;
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

function readThemeMode(value: unknown, fallback: AppearanceSettings['themeMode']): AppearanceSettings['themeMode'] {
  return value === 'light' || value === 'dark' || value === 'system' ? value : fallback;
}

function readThemeIds(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? [...new Set(value as string[])]
    : [...fallback];
}

function readCustomThemes(value: unknown): AppearanceSettings['customThemes'] {
  if (!Array.isArray(value)) return [];
  return value.filter(item => isRecord(item)
    && typeof item.id === 'string' && /^custom-[a-z0-9-]+$/.test(item.id)
    && typeof item.name === 'string' && item.name.trim().length > 0
    && (item.mode === 'light' || item.mode === 'dark')
    && typeof item.description === 'string'
    && isRecord(item.preview)
  ).map(item => ({
    id: item.id as string,
    name: (item.name as string).trim().slice(0, 80),
    mode: item.mode as 'light' | 'dark',
    description: (item.description as string).slice(0, 240),
    preview: Object.fromEntries(Object.entries(item.preview as Record<string, unknown>).filter(([, value]) => typeof value === 'string').slice(0, 40)) as Record<string, string>
  }));
}

/** The only custom-property keys a custom surface pack may set. */
const SURFACE_TOKEN_KEYS: ReadonlySet<string> = new Set([
  '--surface-app-bg-image', '--surface-app-bg-size', '--surface-app-bg-blend',
  '--surface-texture-image', '--surface-texture-size', '--surface-texture-opacity', '--surface-texture-blend',
  '--surface-panel-border-color', '--surface-radius-boost', '--surface-accent-glow',
  '--surface-panel-opacity', '--surface-panel-blur', '--surface-panel-saturate'
]);

function readSurface(value: unknown, fallback: AppearanceSettings['surface']): AppearanceSettings['surface'] {
  if (!isRecord(value)) return { ...fallback };
  const motif = readSurfacePatternSpec(value.motif);
  return {
    intensity: clampNumber(value.intensity, 0, 1, fallback.intensity),
    translucency: readBoolean(value.translucency, fallback.translucency),
    texture: readBoolean(value.texture, fallback.texture),
    windowVibrancy: readBoolean(value.windowVibrancy, fallback.windowVibrancy),
    ...(motif ? { motif } : {})
  };
}

/**
 * Validates a stored watermark-pattern spec. The pattern *library* lives in the
 * renderer, so this deliberately does not police the id against a list — it only
 * enforces a safe shape and clamps the numbers; the renderer drops ids it does
 * not recognise. Nothing here reaches CSS as raw text except `blend`, which is
 * restricted to the CSS blend keywords.
 */
const SURFACE_BLEND_KEYWORDS: ReadonlySet<string> = new Set([
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'soft-light', 'hard-light'
]);

const SURFACE_ANCHORS: ReadonlySet<string> = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);

function readSurfacePatternSpec(value: unknown): SurfaceMotifSettings | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(value.id)) {
    return undefined;
  }
  const blend = typeof value.blend === 'string' && SURFACE_BLEND_KEYWORDS.has(value.blend)
    ? { blend: value.blend }
    : {};
  // The ink colour is baked straight into an SVG `stroke`, so only a literal
  // hex is accepted — never an arbitrary CSS colour expression.
  const inkColor = typeof value.inkColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value.inkColor.trim())
    ? { inkColor: value.inkColor.trim() }
    : {};
  // Same rule for the outline tone — it is baked into an SVG `stroke` too, so a
  // literal hex or nothing. The mode-appropriate default is applied downstream.
  const outlineInk = typeof value.outlineInk === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value.outlineInk.trim())
    ? { outlineInk: value.outlineInk.trim() }
    : {};
  const anchor = typeof value.anchor === 'string' && SURFACE_ANCHORS.has(value.anchor)
    ? { anchor: value.anchor as SurfaceMotifSettings['anchor'] }
    : {};
  return {
    id: value.id,
    scale: clampNumber(value.scale, 8, 400, 120),
    opacity: clampNumber(value.opacity, 0, 1, 0.08),
    ink: value.ink === 'text' ? 'text' : value.ink === 'custom' ? 'custom' : 'accent',
    weight: clampNumber(value.weight, 0.005, 1, 0.055),
    placement: value.placement === 'corner' ? 'corner' : 'tile',
    spread: clampNumber(value.spread, 120, 2400, 720),
    fade: clampNumber(value.fade, 0.05, 1, 0.62),
    fill: clampNumber(value.fill, 0, 1, 0),
    outline: clampNumber(value.outline, 0, 1, 0),
    ...anchor,
    ...inkColor,
    ...outlineInk,
    ...blend
  };
}

function readCustomSurfacePacks(value: unknown): AppearanceSettings['customSurfacePacks'] {
  if (!Array.isArray(value)) return [];
  return value.filter(item => isRecord(item)
    && typeof item.id === 'string' && /^custom-[a-z0-9-]+$/.test(item.id)
    && typeof item.name === 'string' && item.name.trim().length > 0
    && typeof item.description === 'string'
    && isRecord(item.tokens)
  ).map(item => {
    const base = typeof item.basePackId === 'string' && /^[a-z0-9-]+$/.test(item.basePackId)
      ? { basePackId: item.basePackId }
      : {};
    const pattern = readSurfacePatternSpec(item.pattern);
    return {
      id: item.id as string,
      name: (item.name as string).trim().slice(0, 80),
      description: (item.description as string).slice(0, 240),
      ...base,
      ...(pattern ? { pattern } : {}),
      tokens: Object.fromEntries(
        Object.entries(item.tokens as Record<string, unknown>)
          .filter(([key, val]) => SURFACE_TOKEN_KEYS.has(key) && typeof val === 'string')
      ) as Record<string, string>
    };
  });
}

/**
 * Pre-feature profiles carry no `surfacePackId`. Move an *untouched* appearance
 * to the shipped default pack so existing users get the new signature look;
 * leave a *customised* appearance on `'flat'` so nobody's chosen theme changes
 * shape under them. New installs never hit this — they write `DEFAULT_APP_SETTINGS`.
 */
function migratedSurfacePackId(appearance: Record<string, unknown>): string {
  const d = DEFAULT_APP_SETTINGS.appearance;
  const untouched =
    readString(appearance.themeId, d.themeId) === d.themeId &&
    readThemeMode(appearance.themeMode, d.themeMode) === d.themeMode &&
    readBoolean(appearance.showBrandArtwork, d.showBrandArtwork) === d.showBrandArtwork &&
    (!Array.isArray(appearance.customThemes) || appearance.customThemes.length === 0) &&
    JSON.stringify(readPriorityColors(appearance.priorityColors)) === JSON.stringify(d.priorityColors);
  return untouched ? d.surfacePackId : 'flat';
}

function readSurfacePackId(value: unknown, appearance: Record<string, unknown>): string {
  if (typeof value === 'string' && /^[a-z0-9-]+$/.test(value)) return value;
  return migratedSurfacePackId(appearance);
}

function readTerminalCursorStyle(value: unknown, fallback: TerminalCursorStyle): TerminalCursorStyle {
  return value === 'block' || value === 'underline' || value === 'bar' ? value : fallback;
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
    // An empty array is a real, meaningful value here ("curated down to
    // nothing") — unlike the string fields above, it must round-trip as
    // `[]`, not collapse to "unset".
    if (Array.isArray(raw.enabledModelIds) && raw.enabledModelIds.every(v => typeof v === 'string')) {
      config.enabledModelIds = raw.enabledModelIds as string[];
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
        ,themeId: readString(raw.appearance.themeId, DEFAULT_APP_SETTINGS.appearance.themeId)
        ,themeMode: readThemeMode(raw.appearance.themeMode, DEFAULT_APP_SETTINGS.appearance.themeMode)
        ,installedThemeIds: readThemeIds(raw.appearance.installedThemeIds, DEFAULT_APP_SETTINGS.appearance.installedThemeIds)
        ,customThemes: readCustomThemes(raw.appearance.customThemes)
        ,surfacePackId: readSurfacePackId(raw.appearance.surfacePackId, raw.appearance)
        ,surface: readSurface(raw.appearance.surface, DEFAULT_APP_SETTINGS.appearance.surface)
        ,installedSurfacePackIds: readThemeIds(raw.appearance.installedSurfacePackIds, DEFAULT_APP_SETTINGS.appearance.installedSurfacePackIds)
        ,customSurfacePacks: readCustomSurfacePacks(raw.appearance.customSurfacePacks)
      }
    : {
        showBrandArtwork: DEFAULT_APP_SETTINGS.appearance.showBrandArtwork,
        priorityColors: { ...DEFAULT_APP_SETTINGS.appearance.priorityColors }
        ,themeId: DEFAULT_APP_SETTINGS.appearance.themeId
        ,themeMode: DEFAULT_APP_SETTINGS.appearance.themeMode
        ,installedThemeIds: [...DEFAULT_APP_SETTINGS.appearance.installedThemeIds]
        ,customThemes: []
        ,surfacePackId: DEFAULT_APP_SETTINGS.appearance.surfacePackId
        ,surface: { ...DEFAULT_APP_SETTINGS.appearance.surface }
        ,installedSurfacePackIds: [...DEFAULT_APP_SETTINGS.appearance.installedSurfacePackIds]
        ,customSurfacePacks: []
      };

  const git: GitSettings = isRecord(raw) && isRecord(raw.git)
    ? {
        executablePath: readString(raw.git.executablePath, DEFAULT_APP_SETTINGS.git.executablePath),
        defaultBranch: readString(raw.git.defaultBranch, DEFAULT_APP_SETTINGS.git.defaultBranch),
        fetchIntervalMinutes: clampNumber(raw.git.fetchIntervalMinutes, 0, 1440, DEFAULT_APP_SETTINGS.git.fetchIntervalMinutes)
      }
    : { ...DEFAULT_APP_SETTINGS.git };

  const gitVisual: GitVisualSettings = isRecord(raw) && isRecord(raw.gitVisual)
    ? {
        branchColorsEnabled: readBoolean(raw.gitVisual.branchColorsEnabled, DEFAULT_APP_SETTINGS.gitVisual.branchColorsEnabled),
        mergeMarkersEnabled: readBoolean(raw.gitVisual.mergeMarkersEnabled, DEFAULT_APP_SETTINGS.gitVisual.mergeMarkersEnabled),
        orientation: raw.gitVisual.orientation === 'horizontal' ? 'horizontal' : 'vertical',
        performanceMode: readBoolean(raw.gitVisual.performanceMode, DEFAULT_APP_SETTINGS.gitVisual.performanceMode)
      }
    : { ...DEFAULT_APP_SETTINGS.gitVisual };

  const terminal: TerminalSettings = isRecord(raw) && isRecord(raw.terminal)
    ? {
        defaultProfileId: readString(raw.terminal.defaultProfileId, DEFAULT_APP_SETTINGS.terminal.defaultProfileId),
        fontFamily: readString(raw.terminal.fontFamily, DEFAULT_APP_SETTINGS.terminal.fontFamily),
        fontSize: clampNumber(raw.terminal.fontSize, 9, 32, DEFAULT_APP_SETTINGS.terminal.fontSize),
        lineHeight: clampNumber(raw.terminal.lineHeight, 0.9, 2, DEFAULT_APP_SETTINGS.terminal.lineHeight),
        cursorStyle: readTerminalCursorStyle(raw.terminal.cursorStyle, DEFAULT_APP_SETTINGS.terminal.cursorStyle),
        cursorBlink: readBoolean(raw.terminal.cursorBlink, DEFAULT_APP_SETTINGS.terminal.cursorBlink),
        scrollback: clampNumber(raw.terminal.scrollback, 100, 100000, DEFAULT_APP_SETTINGS.terminal.scrollback),
        copyOnSelection: readBoolean(raw.terminal.copyOnSelection, DEFAULT_APP_SETTINGS.terminal.copyOnSelection),
        confirmPaste: readBoolean(raw.terminal.confirmPaste, DEFAULT_APP_SETTINGS.terminal.confirmPaste),
        bellSound: readBoolean(raw.terminal.bellSound, DEFAULT_APP_SETTINGS.terminal.bellSound),
        shellIntegration: readBoolean(raw.terminal.shellIntegration, DEFAULT_APP_SETTINGS.terminal.shellIntegration),
        gpuAcceleration: readBoolean(raw.terminal.gpuAcceleration, DEFAULT_APP_SETTINGS.terminal.gpuAcceleration)
      }
    : { ...DEFAULT_APP_SETTINGS.terminal };

  return {
    ai,
    jira,
    performance,
    delivery,
    mcpServer,
    preview,
    appearance,
    terminal,
    git,
    gitVisual
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
    themeId: patch.appearance?.themeId ?? base.appearance.themeId,
    themeMode: patch.appearance?.themeMode ?? base.appearance.themeMode,
    installedThemeIds: patch.appearance?.installedThemeIds ? [...new Set(patch.appearance.installedThemeIds)] : [...base.appearance.installedThemeIds],
    customThemes: patch.appearance?.customThemes ? [...patch.appearance.customThemes] : [...base.appearance.customThemes],
    surfacePackId: patch.appearance?.surfacePackId ?? base.appearance.surfacePackId,
    surface: { ...base.appearance.surface, ...(patch.appearance?.surface ?? {}) },
    installedSurfacePackIds: patch.appearance?.installedSurfacePackIds ? [...new Set(patch.appearance.installedSurfacePackIds)] : [...base.appearance.installedSurfacePackIds],
    customSurfacePacks: patch.appearance?.customSurfacePacks ? [...patch.appearance.customSurfacePacks] : [...base.appearance.customSurfacePacks],
    priorityColors: isRecord(patch.appearance) && isRecord(patch.appearance.priorityColors)
      ? { ...base.appearance.priorityColors, ...patch.appearance.priorityColors }
      : { ...base.appearance.priorityColors }
  };

  const terminal: TerminalSettings = {
    ...base.terminal,
    ...(patch.terminal ?? {})
  };
  const git: GitSettings = { ...base.git, ...(patch.git ?? {}) };
  const gitVisual: GitVisualSettings = { ...base.gitVisual, ...(patch.gitVisual ?? {}) };

  return {
    ai,
    jira,
    performance,
    delivery,
    mcpServer,
    preview,
    appearance,
    terminal,
    git,
    gitVisual
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
    return join(base, 'praxis', 'settings.json');
  }
  if (platform === 'darwin') {
    return join(env.home, 'Library', 'Application Support', 'praxis', 'settings.json');
  }
  const base = env.XDG_CONFIG_HOME ?? join(env.home, '.config');
  return join(base, 'praxis', 'settings.json');
}
