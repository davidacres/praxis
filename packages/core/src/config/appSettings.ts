import { parseHexRgb } from '../ui/hexColor';
import { NATIVE_ECOSYSTEMS, type NativeEcosystem } from '../ai/agentRuntime/nativeSources';
import type { AiProvider, BuiltInAiProvider } from '../types';
import { sanitizeCustomProviders, type CustomProviderConfig } from '../ai/providers/customProviders';
import type { MobileAccessMode } from '../host/mobileAccessPolicy';
import type { MobileAccessSettings } from '../host/mobileAccessAdministration';

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
  /**
   * Whether this provider is offered for new sessions (Settings → AI Provider →
   * Providers). `undefined` means enabled: a provider is only *usable* when it is
   * also configured (key present / CLI found), so leaving this unset changes
   * nothing for an existing setup. Only an explicit `false` turns a configured
   * provider off. Sessions already running on it are unaffected.
   */
  enabled?: boolean;
  /**
   * Picked from Settings → AI Provider → Add provider. The Providers tab lists
   * a provider when it is configured, the default, or `added` — so an
   * unconfigured built-in stays in the catalog until someone asks for it.
   * Custom endpoints are always listed; this flag is for built-ins.
   */
  added?: boolean;
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
  /**
   * A spend ceiling **the user sets**, in whatever currency their agent reports
   * costs in. `0` disables the warning entirely (the default).
   *
   * Explicitly not a credit balance: nothing Praxis talks to reports one. ACP's
   * `usage_update` carries a cumulative cost but no limit, and the gateway
   * client only calls `/v1/models` and `/v1/chat/completions`. So this is a
   * self-imposed budget checked against genuinely reported spend — never
   * present it as an account balance, and never infer spend for a provider that
   * reports none (API providers report tokens, not cost; turning tokens into
   * money needs a price table this app does not have and could not keep true).
   */
  spendLimit: number;
  /** Which configured provider new sessions use by default. */
  activeProvider: AiProvider;
  /**
   * Which provider (direct API or ACP-hosted CLI agent)
   * one-shot AI "recommendation" features (workflow template pick, workflow
   * agent-for-stage pick) use. `undefined` means auto: prefer `activeProvider`
   * if it qualifies and is configured, else the first configured API provider
   * or available ACP host — see `resolveRecommendationProvider`.
   */
  recommendationProvider?: AiProvider;
  /**
   * What each model tier (`fast` / `standard` / `strong`) means per provider, as model ids. A workflow
   * stage names a tier, not a model, so the same workflow runs on whichever provider is active. A tier
   * left unmapped makes a stage fall back to the run's model — see `chooseStageModel`.
   */
  modelTiers?: Record<string, { fast?: string; standard?: string; strong?: string }>;
  /**
   * Per-provider non-secret config, keyed by provider id. `vercel-gateway`'s
   * effective config stays on the top-level `gatewayUrl`/`defaultModel`
   * fields above for backward compatibility — this map is for the other
   * providers only.
   */
  providers: Partial<Record<AiProvider, AiProviderConfig>>;
  /**
   * User-added OpenAI-compatible endpoints (FX-BF-044). Omitted when there are
   * none, so a settings file written before this existed round-trips unchanged.
   * Per-endpoint `enabled` / `defaultModel` / `enabledModelIds` / `added` live in
   * `providers[id]` exactly as for a built-in.
   */
  customProviders?: CustomProviderConfig[];
  /**
   * The in-app browser the AI can drive (navigate / read / click / type) during
   * a full-tools session. Off by default: it lets a model fetch arbitrary web
   * pages, so it is opt-in and every navigation still prompts for permission
   * unless its host is on `allowedHosts`.
   */
  browserTools: {
    enabled: boolean;
    /**
     * Hostnames (exact, or `*.example.com` wildcards) the agent may navigate to
     * without a per-navigation prompt. Loopback and private-range addresses are
     * always blocked regardless of this list.
     */
    allowedHosts: string[];
  };
  /**
   * Agents, skills and instruction files other AI tools keep (Claude Code,
   * Codex, Copilot, Gemini / Antigravity, Cursor), read in place.
   */
  nativeSources: NativeSourceSettings;
  /** Working habits Praxis asks every AI to follow, so sessions feel the same on any runtime. */
  workingStyle: WorkingStyleSettings;
}

export interface WorkingStyleSettings {
  enabled: boolean;
  /** The user's own wording; empty uses Praxis's (`DEFAULT_WORKING_STYLE`). */
  text: string;
}

/** Praxis's working style: the same habits whichever AI runs the session. */
export const DEFAULT_WORKING_STYLE = [
  '- Before a multi-step change, state a short plan and keep it up to date as a checklist while you work.',
  '- Before anything that is hard to undo — deleting files, rewriting history, publishing, changing shared systems — say what you are about to do and wait for approval.',
  '- Make small, reviewable changes that read like the surrounding code.',
  '- Verify your work with the project’s own build and tests, and say plainly when you could not.',
  '- Finish with a short summary: what changed, how you verified it, and anything left for the user.'
].join('\n');

export interface NativeSourceSettings {
  /** Tools whose folders are read; a tool missing here is read. */
  ecosystems: Partial<Record<NativeEcosystem, boolean>>;
  /** Project roots whose files the user approved (a clone's files are untrusted until then). */
  approvedProjects: string[];
  /** Add a project's instruction files to sessions on runtimes that do not read them natively. */
  injectInstructions: boolean;
  /**
   * Whose instruction files Praxis adds: every tool's (`all`), or only one
   * tool's — its files become the project's instructions for every AI.
   */
  instructionSource: 'all' | NativeEcosystem;
  /** Extra folders of skills (each `<name>/SKILL.md`) or agent `.md` files. */
  extraSkillPaths: string[];
  extraAgentPaths: string[];
}

const KNOWN_AI_PROVIDERS: readonly BuiltInAiProvider[] = [
  'vercel-gateway',
  'openai',
  'anthropic',
  'gemini',
  'z-ai',
  'claude-code-cli',
  'codex-cli',
  'copilot-cli',
  'antigravity-cli'
];

export interface PreviewSettings {
  /** Enable the Create Idea command and button (preview). */
  enableCreateIdea: boolean;
  /** Enable the New Project wizard (preview). */
  enableNewProject: boolean;
  /** Boards sidebar layout — 'classic' (separate views) or 'work' (board-centric). */
  boardsSidebarMode: BoardsSidebarMode;
  /** Enable the experimental EasyMode sidebar view. */
  enableEasyMode: boolean;
  /** Enable deployment profiles, targets, and delivery runs for projects. */
  enableDeployments: boolean;
}

export interface StartupSettings {
  /** Reopen the last valid desktop workspace and durable view instead of Getting Started. */
  reopenLastWorkspace: boolean;
}

/**
 * The add-on marketplace — a GitHub Packages npm registry the app browses for
 * installable themes, surface packs, agents and workflow templates. The GitHub
 * token is a secret and lives in the secrets store, not here.
 */
export interface MarketplaceSettings {
  /** Master switch. When false the marketplace UI is hidden and nothing is fetched. */
  enabled: boolean;
  /** GitHub user or org that publishes the add-on packages. */
  owner: string;
  ownerType: 'user' | 'org';
  /** Package-name prefix that marks a package as a Praxis add-on. */
  packageNamePrefix: string;
  /** GitHub REST API base — override for GitHub Enterprise Server. */
  apiBaseUrl: string;
  /** npm registry base that serves packuments and tarballs. */
  registryBaseUrl: string;
  /** Check installed add-ons for updates on launch. */
  checkOnLaunch: boolean;
}

export interface AppearanceSettings {
  /** UI density preference; compact is the default, large improves readability and touch targets. */
  displayMode: 'compact' | 'large';
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
     * Master gate on motif motion. The per-motif `animation` style below picks
     * *which* movement; this switches all of it off in one place, the way
     * `texture` gates the grain. The OS `prefers-reduced-motion` preference
     * overrides it in the renderer regardless.
     */
    animateMotifs: boolean;
    /**
     * Drop the surface material (texture, watermark, tint, glow, blur) behind
     * the AI chat session view — its list panel and console — so long
     * transcripts stay legible. The colour theme still applies; the panels fall
     * back to flat themed fills. A profile-wide default; the sessions view also
     * carries a per-session override on top of it.
     */
    plainChatSurface: boolean;
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
  /**
   * Saved appearance presets ("Looks"). Each bundles the whole appearance stack —
   * theme, mode, surface pack, dials/motif, priority colours, brand-artwork
   * toggle — so the user can switch the entire look in one click. The live
   * `appearance` fields above stay the source of truth for rendering; the active
   * Look is kept mirrored to them on every appearance write (see
   * `mirrorActiveLook`). Ships four built-ins; users add their own.
   */
  looks: AppearanceLook[];
  /**
   * Id of the Look currently selected in Settings. `''` means detached — no Look
   * is selected and edits are not mirrored anywhere.
   */
  activeLookId: string;
  /** Whole-window UI zoom factor (0.7 to 1.5, default 1). Remembered between restarts. */
  zoomFactor: number;
}

/**
 * A saved appearance preset. Captures everything in the Appearance section except
 * the libraries (`customThemes`, `customSurfacePacks`, `installed*Ids`), which are
 * shared across every Look.
 */
export interface AppearanceLook {
  /** Built-ins: `look-parchment` | `look-blueprint` | `look-aurora` | `look-flat`. User packs: `look-<base36>`. */
  id: string;
  /** User-facing name, ≤ 80 chars. */
  name: string;
  themeId: string;
  themeMode: 'light' | 'dark' | 'system';
  surfacePackId: string;
  /** The surface dials + motif override, same shape as `AppearanceSettings['surface']`. */
  surface: AppearanceSettings['surface'];
  priorityColors: Record<string, string>;
  showBrandArtwork: boolean;
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
  /** Which window corner a `corner` motif grows from. Legacy single-corner form. */
  anchor?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /**
   * The corners a `corner` motif is mirrored into — one to four. Supersedes the
   * singular `anchor` whenever it is present and non-empty; `anchor` is kept so
   * older profiles and pack definitions keep working.
   */
  anchors?: Array<'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'>;
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
  /**
   * How the motif moves. Orthogonal to which pattern it is, so any style rides
   * over any pattern. Held flat rather than nested because a pack's pattern and
   * the user's override are merged by shallow spread — a nested object would
   * replace wholesale and break partial overrides.
   */
  animation?: SurfaceMotifAnimation;
  /** Multiplier on the style's base duration. Higher is faster. */
  animationSpeed?: number;
  /** Reveal styles only: loop, or draw once and rest complete (the default). */
  animationRepeat?: boolean;
}

/**
 * The motif animation styles. Two families: `draw` / `plot` / `iterate` are
 * *reveal* styles baked into the motif's own SVG (they need its geometry);
 * the rest act on the painted layer through CSS. `cyberpunk` uses both.
 */
export type SurfaceMotifAnimation =
  | 'none'
  | 'draw'
  | 'plot'
  | 'iterate'
  | 'shimmer'
  | 'glow'
  | 'drift'
  | 'ripple'
  | 'neon'
  | 'cyberpunk';

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
  startup: StartupSettings;
  marketplace: MarketplaceSettings;
  preview: PreviewSettings;
  appearance: AppearanceSettings;
  terminal: TerminalSettings;
  git: GitSettings;
  gitVisual: GitVisualSettings;
  mobileAccess: MobileAccessSettings;
}

/** The priority-colour map every fresh profile and every built-in Look starts from. */
const DEFAULT_PRIORITY_COLORS: Record<string, string> = {
  Critical: '#DC2626',
  Highest: 'linear-gradient(to bottom, #DC2626, #EA580C)',
  High: '#F59E0B',
  Medium: 'linear-gradient(to bottom, #F59E0B, #3B82F6)',
  Low: 'linear-gradient(to bottom, #3B82F6, #22C55E)',
  Lowest: '#22C55E'
};

/** One shipped Look: the default theme/dials, differing only by surface pack. */
function builtInLook(id: string, name: string, surfacePackId: string, motif?: AppearanceSettings['surface']['motif']): AppearanceLook {
  return {
    id,
    name,
    themeId: 'praxis-dark',
    themeMode: 'dark',
    surfacePackId,
    surface: {
      intensity: 1, translucency: true, texture: true, windowVibrancy: false, animateMotifs: true, plainChatSurface: false,
      ...(motif ? { motif } : {})
    },
    priorityColors: { ...DEFAULT_PRIORITY_COLORS },
    showBrandArtwork: true
  };
}

/** The four Looks the strip is seeded with. `look-parchment` equals today's shipped appearance. */
export const BUILT_IN_LOOKS: AppearanceLook[] = [
  builtInLook('look-parchment', 'Parchment', 'parchment'),
  builtInLook('look-blueprint', 'Blueprint', 'parchment', { id: 'grid', scale: 104, opacity: 0.3, ink: 'accent' }),
  builtInLook('look-aurora', 'Aurora', 'aurora-glass'),
  builtInLook('look-flat', 'Flat', 'flat')
];

/** Shipped defaults — kept in sync with `package.json` contributes.configuration. */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  ai: {
    gatewayUrl: '',
    defaultModel: '',
    agentName: '',
    workingDirectory: '',
    analysisPrompt: '',
    analysisGateEnabled: false,
    spendLimit: 0,
    activeProvider: 'vercel-gateway',
    providers: {},
    browserTools: { enabled: false, allowedHosts: [] },
    nativeSources: { ecosystems: {}, approvedProjects: [], injectInstructions: true, instructionSource: 'all', extraSkillPaths: [], extraAgentPaths: [] },
    workingStyle: { enabled: true, text: '' }
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
  startup: {
    reopenLastWorkspace: true
  },
  marketplace: {
    enabled: false,
    owner: '',
    ownerType: 'user',
    packageNamePrefix: 'praxis-addon-',
    apiBaseUrl: 'https://api.github.com',
    registryBaseUrl: 'https://npm.pkg.github.com',
    checkOnLaunch: true
  },
  preview: {
    enableCreateIdea: false,
    enableNewProject: true,
    boardsSidebarMode: 'classic',
    enableEasyMode: false,
    enableDeployments: false
  },
  appearance: {
    displayMode: 'compact',
    showBrandArtwork: true,
    themeId: 'praxis-light',
    themeMode: 'light',
    installedThemeIds: ['praxis-light', 'praxis-dark', 'tm-default-1', 'tm-default-2', 'simple'],
    customThemes: [],
    surfacePackId: 'parchment',
    surface: { intensity: 1, translucency: true, texture: true, windowVibrancy: false, animateMotifs: true, plainChatSurface: false },
    installedSurfacePackIds: ['flat', 'parchment', 'graphite', 'aurora-glass', 'noir'],
    customSurfacePacks: [],
    looks: BUILT_IN_LOOKS.map(look => ({ ...look, surface: { ...look.surface }, priorityColors: { ...look.priorityColors } })),
    activeLookId: 'look-parchment',
    priorityColors: { ...DEFAULT_PRIORITY_COLORS },
    zoomFactor: 1
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
  },
  mobileAccess: {
    mode: 'off',
    hostName: '',
    allowedInterfaces: [],
    allowedSubnets: [],
    listenPort: 43100,
    remoteSignInRequired: false
  }
};

/**
 * Deep-partial patch that callers send to `SettingsBackend.write`. Each
 * section is optional; nested sections merge key-by-key; priorityColors merges
 * per-key so a patch touching one priority doesn't reset the others.
 */
export interface AppSettingsPatch {
  ai?: Partial<Omit<AiSettings, 'browserTools' | 'nativeSources' | 'workingStyle'>> & {
    browserTools?: Partial<AiSettings['browserTools']>;
    nativeSources?: Partial<NativeSourceSettings>;
    workingStyle?: Partial<WorkingStyleSettings>;
  };
  jira?: Partial<JiraSettings>;
  performance?: Partial<PerformanceSettings>;
  delivery?: Partial<DeliverySettings>;
  mcpServer?: Partial<McpServerSettings>;
  startup?: Partial<StartupSettings>;
  marketplace?: Partial<MarketplaceSettings>;
  preview?: Partial<PreviewSettings>;
  appearance?: {
    displayMode?: 'compact' | 'large';
    zoomFactor?: number;
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
    looks?: AppearanceLook[];
    activeLookId?: string;
  };
  terminal?: Partial<TerminalSettings>;
  git?: Partial<GitSettings>;
  gitVisual?: Partial<GitVisualSettings>;
  mobileAccess?: Partial<MobileAccessSettings>;
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

function readDisplayMode(value: unknown, fallback: AppearanceSettings['displayMode']): AppearanceSettings['displayMode'] {
  return value === 'compact' || value === 'large' ? value : fallback;
}

function readMobileAccessMode(value: unknown, fallback: MobileAccessMode): MobileAccessMode {
  return value === 'off' || value === 'local-only' || value === 'internet' ? value : fallback;
}

function readStringList(value: unknown, fallback: readonly string[]): string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? [...new Set((value as string[]).map(item => item.trim()).filter(Boolean))]
    : [...fallback];
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
    animateMotifs: readBoolean(value.animateMotifs, fallback.animateMotifs),
    plainChatSurface: readBoolean(value.plainChatSurface, fallback.plainChatSurface),
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

/**
 * The animation style reaches CSS as a `data-motif-anim` attribute value and
 * selects a keyframe block, so — like `blend` and the anchors — it is validated
 * to a literal from a fixed set rather than passed through as user text.
 */
const SURFACE_MOTIF_ANIMATIONS: ReadonlySet<string> = new Set([
  'none', 'draw', 'plot', 'iterate', 'shimmer', 'glow', 'drift', 'ripple', 'neon', 'cyberpunk'
]);

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
  // Each corner is baked into a separate SVG layer, so validate to the literal
  // set, de-duplicate, and cap at the four real corners. An empty result is
  // dropped so the singular `anchor` (or the default) still applies.
  const anchorList = Array.isArray(value.anchors)
    ? (value.anchors.filter(
        (item): item is NonNullable<SurfaceMotifSettings['anchor']> =>
          typeof item === 'string' && SURFACE_ANCHORS.has(item)
      ) as NonNullable<SurfaceMotifSettings['anchors']>)
        .filter((item, index, list) => list.indexOf(item) === index)
        .slice(0, 4)
    : [];
  const anchors = anchorList.length ? { anchors: anchorList } : {};
  const animation = typeof value.animation === 'string' && SURFACE_MOTIF_ANIMATIONS.has(value.animation)
    ? { animation: value.animation as SurfaceMotifAnimation }
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
    animationSpeed: clampNumber(value.animationSpeed, 0.25, 4, 1),
    animationRepeat: readBoolean(value.animationRepeat, false),
    ...animation,
    ...anchor,
    ...anchors,
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
 * Validates the saved Looks. Each entry must name a real-shaped preset; the
 * theme/pack ids are only shape-checked (the renderer owns the catalogues and
 * ignores ids it does not know), and the nested dials/colours reuse the same
 * validators as the live `appearance` fields. An absent or non-array value falls
 * back to the shipped built-ins.
 */
function readLooks(value: unknown, fallback: AppearanceSettings['looks']): AppearanceSettings['looks'] {
  if (!Array.isArray(value)) {
    return fallback.map(look => ({ ...look, surface: { ...look.surface }, priorityColors: { ...look.priorityColors } }));
  }
  return value
    .filter(item => isRecord(item)
      && typeof item.id === 'string' && /^look-[a-z0-9-]+$/.test(item.id)
      && typeof item.name === 'string' && item.name.trim().length > 0
      && typeof item.themeId === 'string' && /^[a-z0-9-]+$/.test(item.themeId)
      && typeof item.surfacePackId === 'string' && /^[a-z0-9-]+$/.test(item.surfacePackId))
    .map(item => {
      const legacyMotif = legacySurfaceMotif(item.surfacePackId);
      const surface = readSurface(item.surface, DEFAULT_APP_SETTINGS.appearance.surface);
      return {
        id: item.id as string,
        name: (item.name as string).trim().slice(0, 80),
        themeId: item.themeId as string,
        themeMode: readThemeMode(item.themeMode, DEFAULT_APP_SETTINGS.appearance.themeMode),
        surfacePackId: legacyMotif ? 'parchment' : item.surfacePackId as string,
        surface: legacyMotif && !surface.motif ? { ...surface, motif: legacyMotif } : surface,
        priorityColors: readPriorityColors(item.priorityColors),
        showBrandArtwork: readBoolean(item.showBrandArtwork, DEFAULT_APP_SETTINGS.appearance.showBrandArtwork)
      };
    });
}

/** Blueprint and Binary were early surface presets; retain their visual intent as motifs. */
function legacySurfaceMotif(value: unknown): AppearanceSettings['surface']['motif'] | undefined {
  if (value === 'blueprint') return { id: 'grid', scale: 104, opacity: 0.3, ink: 'accent' };
  if (value === 'binary') return { id: 'binary', scale: 112, opacity: 0.2, ink: 'accent' };
  return undefined;
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
  if (typeof value === 'string' && /^[a-z0-9-]+$/.test(value)) {
    return legacySurfaceMotif(value) ? 'parchment' : value;
  }
  return migratedSurfacePackId(appearance);
}

function readTerminalCursorStyle(value: unknown, fallback: TerminalCursorStyle): TerminalCursorStyle {
  return value === 'block' || value === 'underline' || value === 'bar' ? value : fallback;
}

/** Built-ins plus the ids of the endpoints actually present — a stale `custom:` id is not a provider. */
function knownProviderIds(customProviders: readonly CustomProviderConfig[]): string[] {
  return [...KNOWN_AI_PROVIDERS, ...customProviders.map(provider => provider.id)];
}

function readAiProvider(value: unknown, fallback: AiProvider, known: readonly string[]): AiProvider {
  return typeof value === 'string' && known.includes(value) ? (value as AiProvider) : fallback;
}

function readOptionalAiProvider(value: unknown, known: readonly string[]): AiProvider | undefined {
  return typeof value === 'string' && known.includes(value) ? (value as AiProvider) : undefined;
}

/** Provider → tier → model id; anything that is not a non-empty string is dropped. */
function readModelTiers(value: unknown): NonNullable<AiSettings['modelTiers']> {
  const result: NonNullable<AiSettings['modelTiers']> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [provider, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry: { fast?: string; standard?: string; strong?: string } = {};
    for (const tier of ['fast', 'standard', 'strong'] as const) {
      const model = (raw as Record<string, unknown>)[tier];
      if (typeof model === 'string' && model.trim()) entry[tier] = model.trim();
    }
    if (Object.keys(entry).length > 0) result[provider] = entry;
  }
  return result;
}

function readAiProviderConfigs(value: unknown, known: readonly string[]): Partial<Record<AiProvider, AiProviderConfig>> {
  if (!isRecord(value)) {
    return {};
  }
  const out: Partial<Record<AiProvider, AiProviderConfig>> = {};
  for (const id of known as readonly AiProvider[]) {
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
    if (typeof raw.enabled === 'boolean') {
      config.enabled = raw.enabled;
    }
    if (raw.added === true) {
      config.added = true;
    }
    if (Object.keys(config).length > 0) {
      out[id] = config;
    }
  }
  return out;
}

function readBrowserTools(value: unknown): AiSettings['browserTools'] {
  const fallback = DEFAULT_APP_SETTINGS.ai.browserTools;
  if (!isRecord(value)) {
    return { enabled: fallback.enabled, allowedHosts: [] };
  }
  const allowedHosts = Array.isArray(value.allowedHosts)
    ? value.allowedHosts
        .filter((host): host is string => typeof host === 'string' && host.trim().length > 0)
        .map(host => host.trim().toLowerCase())
    : [];
  return {
    enabled: readBoolean(value.enabled, fallback.enabled),
    allowedHosts: [...new Set(allowedHosts)]
  };
}

function readNativeSources(value: unknown): NativeSourceSettings {
  const fallback = DEFAULT_APP_SETTINGS.ai.nativeSources;
  if (!isRecord(value)) return { ...fallback, ecosystems: {}, approvedProjects: [], extraSkillPaths: [], extraAgentPaths: [] };
  const ecosystems: NativeSourceSettings['ecosystems'] = {};
  if (isRecord(value.ecosystems)) {
    for (const ecosystem of NATIVE_ECOSYSTEMS) {
      if (typeof value.ecosystems[ecosystem] === 'boolean') ecosystems[ecosystem] = value.ecosystems[ecosystem] as boolean;
    }
  }
  return {
    ecosystems,
    approvedProjects: readStringList(value.approvedProjects, []),
    injectInstructions: readBoolean(value.injectInstructions, fallback.injectInstructions),
    instructionSource: value.instructionSource === 'all' || (NATIVE_ECOSYSTEMS as readonly unknown[]).includes(value.instructionSource)
      ? (value.instructionSource as NativeSourceSettings['instructionSource'])
      : fallback.instructionSource,
    extraSkillPaths: readStringList(value.extraSkillPaths, []),
    extraAgentPaths: readStringList(value.extraAgentPaths, [])
  };
}

function readWorkingStyle(value: unknown): WorkingStyleSettings {
  const fallback = DEFAULT_APP_SETTINGS.ai.workingStyle;
  if (!isRecord(value)) return { ...fallback };
  return { enabled: readBoolean(value.enabled, fallback.enabled), text: readString(value.text, fallback.text) };
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
  const customProviders = isRecord(raw) && isRecord(raw.ai) ? sanitizeCustomProviders(raw.ai.customProviders) : [];
  const knownProviders = knownProviderIds(customProviders);
  const ai: AiSettings = isRecord(raw) && isRecord(raw.ai)
    ? {
        gatewayUrl: readString(raw.ai.gatewayUrl, DEFAULT_APP_SETTINGS.ai.gatewayUrl),
        defaultModel: readString(raw.ai.defaultModel, DEFAULT_APP_SETTINGS.ai.defaultModel),
        agentName: readString(raw.ai.agentName, DEFAULT_APP_SETTINGS.ai.agentName),
        workingDirectory: readString(raw.ai.workingDirectory, DEFAULT_APP_SETTINGS.ai.workingDirectory),
        analysisPrompt: readString(raw.ai.analysisPrompt, DEFAULT_APP_SETTINGS.ai.analysisPrompt),
        spendLimit: clampNumber(raw.ai.spendLimit, 0, Number.MAX_SAFE_INTEGER, DEFAULT_APP_SETTINGS.ai.spendLimit),
        analysisGateEnabled: readBoolean(
          raw.ai.analysisGateEnabled,
          DEFAULT_APP_SETTINGS.ai.analysisGateEnabled
        ),
        activeProvider: readAiProvider(raw.ai.activeProvider, DEFAULT_APP_SETTINGS.ai.activeProvider, knownProviders),
        recommendationProvider: readOptionalAiProvider(raw.ai.recommendationProvider, knownProviders),
        modelTiers: readModelTiers(raw.ai.modelTiers),
        providers: readAiProviderConfigs(raw.ai.providers, knownProviders),
        ...(customProviders.length > 0 ? { customProviders } : {}),
        browserTools: readBrowserTools(raw.ai.browserTools),
        nativeSources: readNativeSources(raw.ai.nativeSources),
        workingStyle: readWorkingStyle(raw.ai.workingStyle)
      }
    : {
        ...DEFAULT_APP_SETTINGS.ai,
        providers: { ...DEFAULT_APP_SETTINGS.ai.providers },
        browserTools: { ...DEFAULT_APP_SETTINGS.ai.browserTools, allowedHosts: [] },
        nativeSources: readNativeSources(undefined),
        workingStyle: readWorkingStyle(undefined)
      };

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

  const startup: StartupSettings = isRecord(raw) && isRecord(raw.startup)
    ? {
        reopenLastWorkspace: readBoolean(
          raw.startup.reopenLastWorkspace,
          DEFAULT_APP_SETTINGS.startup.reopenLastWorkspace
        )
      }
    : { ...DEFAULT_APP_SETTINGS.startup };

  const marketplace: MarketplaceSettings = isRecord(raw) && isRecord(raw.marketplace)
    ? {
        enabled: readBoolean(raw.marketplace.enabled, DEFAULT_APP_SETTINGS.marketplace.enabled),
        owner: readString(raw.marketplace.owner, DEFAULT_APP_SETTINGS.marketplace.owner),
        ownerType: raw.marketplace.ownerType === 'org' ? 'org' : 'user',
        packageNamePrefix: readString(
          raw.marketplace.packageNamePrefix,
          DEFAULT_APP_SETTINGS.marketplace.packageNamePrefix
        ),
        apiBaseUrl: readString(raw.marketplace.apiBaseUrl, DEFAULT_APP_SETTINGS.marketplace.apiBaseUrl),
        registryBaseUrl: readString(
          raw.marketplace.registryBaseUrl,
          DEFAULT_APP_SETTINGS.marketplace.registryBaseUrl
        ),
        checkOnLaunch: readBoolean(
          raw.marketplace.checkOnLaunch,
          DEFAULT_APP_SETTINGS.marketplace.checkOnLaunch
        )
      }
    : { ...DEFAULT_APP_SETTINGS.marketplace };

  const preview: PreviewSettings = isRecord(raw) && isRecord(raw.preview)
    ? {
        enableCreateIdea: readBoolean(raw.preview.enableCreateIdea, DEFAULT_APP_SETTINGS.preview.enableCreateIdea),
        enableNewProject: readBoolean(raw.preview.enableNewProject, DEFAULT_APP_SETTINGS.preview.enableNewProject),
        boardsSidebarMode: readBoardsSidebarMode(
          raw.preview.boardsSidebarMode,
          DEFAULT_APP_SETTINGS.preview.boardsSidebarMode
        ),
        enableEasyMode: readBoolean(raw.preview.enableEasyMode, DEFAULT_APP_SETTINGS.preview.enableEasyMode),
        enableDeployments: readBoolean(raw.preview.enableDeployments, DEFAULT_APP_SETTINGS.preview.enableDeployments)
      }
    : { ...DEFAULT_APP_SETTINGS.preview };

  // Looks + the active id are resolved first so the id can be blanked when it
  // names no surviving Look ("detached"). Only a fresh profile inherits the
  // default `activeLookId`; an existing profile with no stored Looks gets the
  // built-ins but stays detached, so we never retroactively claim its setup
  // matches one.
  const hasAppearance = isRecord(raw) && isRecord(raw.appearance);
  const appearanceLooks = hasAppearance
    ? readLooks((raw.appearance as Record<string, unknown>).looks, DEFAULT_APP_SETTINGS.appearance.looks)
    : readLooks(undefined, DEFAULT_APP_SETTINGS.appearance.looks);
  const requestedLookId = hasAppearance
    ? readString((raw.appearance as Record<string, unknown>).activeLookId, '')
    : DEFAULT_APP_SETTINGS.appearance.activeLookId;
  const appearanceActiveLookId = appearanceLooks.some(look => look.id === requestedLookId) ? requestedLookId : '';
  const rawSurfacePackId = hasAppearance ? (raw.appearance as Record<string, unknown>).surfacePackId : undefined;
  const legacyActiveMotif = legacySurfaceMotif(rawSurfacePackId);
  const appearanceSurface = readSurface(
    hasAppearance ? (raw.appearance as Record<string, unknown>).surface : undefined,
    DEFAULT_APP_SETTINGS.appearance.surface
  );
  const migratedAppearanceSurface = legacyActiveMotif && !appearanceSurface.motif
    ? { ...appearanceSurface, motif: legacyActiveMotif }
    : appearanceSurface;

  const appearance: AppearanceSettings = isRecord(raw) && isRecord(raw.appearance)
    ? {
        displayMode: readDisplayMode(raw.appearance.displayMode, DEFAULT_APP_SETTINGS.appearance.displayMode),
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
        ,surface: migratedAppearanceSurface
        ,installedSurfacePackIds: readThemeIds(raw.appearance.installedSurfacePackIds, DEFAULT_APP_SETTINGS.appearance.installedSurfacePackIds)
        ,customSurfacePacks: readCustomSurfacePacks(raw.appearance.customSurfacePacks)
        ,looks: appearanceLooks
        ,activeLookId: appearanceActiveLookId
        ,zoomFactor: clampNumber(raw.appearance.zoomFactor, 0.7, 1.5, DEFAULT_APP_SETTINGS.appearance.zoomFactor)
      }
    : {
        displayMode: DEFAULT_APP_SETTINGS.appearance.displayMode,
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
        ,looks: appearanceLooks
        ,activeLookId: appearanceActiveLookId
        ,zoomFactor: DEFAULT_APP_SETTINGS.appearance.zoomFactor
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

  const mobileAccess: MobileAccessSettings = isRecord(raw) && isRecord(raw.mobileAccess)
    ? {
        mode: readMobileAccessMode(raw.mobileAccess.mode, DEFAULT_APP_SETTINGS.mobileAccess.mode),
        hostName: readString(raw.mobileAccess.hostName, DEFAULT_APP_SETTINGS.mobileAccess.hostName),
        allowedInterfaces: readStringList(raw.mobileAccess.allowedInterfaces, DEFAULT_APP_SETTINGS.mobileAccess.allowedInterfaces),
        allowedSubnets: readStringList(raw.mobileAccess.allowedSubnets, DEFAULT_APP_SETTINGS.mobileAccess.allowedSubnets),
        listenPort: clampNumber(raw.mobileAccess.listenPort, 1024, 65535, DEFAULT_APP_SETTINGS.mobileAccess.listenPort),
        remoteSignInRequired: readBoolean(raw.mobileAccess.remoteSignInRequired, DEFAULT_APP_SETTINGS.mobileAccess.remoteSignInRequired)
      }
    : { ...DEFAULT_APP_SETTINGS.mobileAccess };

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
    startup,
    marketplace,
    preview,
    appearance,
    terminal,
    git,
    gitVisual,
    mobileAccess
  };
}

/** Merges per-provider config one level deep, so a patch touching one field of one provider doesn't drop its others. */
function mergeAiProviderConfigs(
  base: Partial<Record<AiProvider, AiProviderConfig>>,
  patch: Partial<Record<AiProvider, AiProviderConfig>>,
  known: readonly string[]
): Partial<Record<AiProvider, AiProviderConfig>> {
  const out: Partial<Record<AiProvider, AiProviderConfig>> = { ...base };
  for (const id of known as readonly AiProvider[]) {
    const patchConfig = patch[id];
    if (patchConfig) {
      out[id] = { ...base[id], ...patchConfig };
    }
  }
  return out;
}

/**
 * Keeps the active Look mirrored to the live appearance fields. Runs after every
 * appearance write that *edits* the current Look — never a switch to another one
 * (`activeLookId` present in the patch) or a wholesale `looks` rewrite. Both UI
 * surfaces funnel through `mergeAppSettings`, so no individual control needs its
 * own wiring. Replaces the matching entry with a fresh object so `base` is never
 * mutated.
 */
function mirrorActiveLook(appearance: AppearanceSettings, patch: AppSettingsPatch): void {
  if (!patch.appearance) return;
  if (patch.appearance.activeLookId !== undefined || patch.appearance.looks !== undefined) return;
  const id = appearance.activeLookId;
  if (!id) return;
  // Built-in Looks are shipped presets. Editing another appearance control
  // while one is selected must detach rather than rewrite the preset.
  if (BUILT_IN_LOOKS.some(look => look.id === id)) {
    appearance.activeLookId = '';
    return;
  }
  const index = appearance.looks.findIndex(look => look.id === id);
  if (index < 0) return;
  appearance.looks = appearance.looks.map((look, i) => i === index
    ? {
        id: look.id,
        name: look.name,
        themeId: appearance.themeId,
        themeMode: appearance.themeMode,
        surfacePackId: appearance.surfacePackId,
        surface: {
          ...appearance.surface,
          ...(appearance.surface.motif ? { motif: { ...appearance.surface.motif } } : {})
        },
        priorityColors: { ...appearance.priorityColors },
        showBrandArtwork: appearance.showBrandArtwork
      }
    : look);
}

/** Deep-merge a patch over a base — returns a new object, never mutating inputs. */
export function mergeAppSettings(base: AppSettings, patch: AppSettingsPatch): AppSettings {
  // A list, not a map: a patch carrying `customProviders` replaces it wholesale.
  const customProviders = patch.ai && 'customProviders' in patch.ai
    ? sanitizeCustomProviders(patch.ai.customProviders)
    : base.ai.customProviders ?? [];
  const ai: AiSettings = {
    ...base.ai,
    ...(patch.ai ?? {}),
    providers: isRecord(patch.ai?.providers)
      ? mergeAiProviderConfigs(
          base.ai.providers,
          patch.ai!.providers as Partial<Record<AiProvider, AiProviderConfig>>,
          knownProviderIds(customProviders)
        )
      : base.ai.providers,
    browserTools: isRecord(patch.ai?.browserTools)
      ? { ...base.ai.browserTools, ...patch.ai!.browserTools }
      : base.ai.browserTools,
    nativeSources: isRecord(patch.ai?.nativeSources)
      ? {
          ...base.ai.nativeSources,
          ...patch.ai!.nativeSources,
          ecosystems: { ...base.ai.nativeSources.ecosystems, ...(patch.ai!.nativeSources!.ecosystems ?? {}) }
        }
      : base.ai.nativeSources,
    workingStyle: isRecord(patch.ai?.workingStyle) ? { ...base.ai.workingStyle, ...patch.ai!.workingStyle } : base.ai.workingStyle
  };
  if (customProviders.length > 0) ai.customProviders = customProviders;
  else delete ai.customProviders;
  // Removing an endpoint must not leave a setting pointing at it.
  const removed = (base.ai.customProviders ?? []).filter(old => !customProviders.some(kept => kept.id === old.id));
  if (removed.length > 0) {
    const providers = { ...ai.providers };
    for (const { id } of removed) {
      delete providers[id];
      if (ai.activeProvider === id) ai.activeProvider = DEFAULT_APP_SETTINGS.ai.activeProvider;
      if (ai.recommendationProvider === id) ai.recommendationProvider = undefined;
      if (ai.modelTiers?.[id]) {
        const { [id]: _dropped, ...rest } = ai.modelTiers;
        ai.modelTiers = rest;
      }
    }
    ai.providers = providers;
  }

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

  const startup: StartupSettings = {
    ...base.startup,
    ...(patch.startup ?? {})
  };

  const marketplace: MarketplaceSettings = {
    ...base.marketplace,
    ...(patch.marketplace ?? {})
  };

  const preview: PreviewSettings = {
    ...base.preview,
    ...(patch.preview ?? {})
  };

  const appearance: AppearanceSettings = {
    displayMode: patch.appearance?.displayMode ?? base.appearance.displayMode,
    showBrandArtwork: patch.appearance?.showBrandArtwork ?? base.appearance.showBrandArtwork,
    themeId: patch.appearance?.themeId ?? base.appearance.themeId,
    themeMode: patch.appearance?.themeMode ?? base.appearance.themeMode,
    installedThemeIds: patch.appearance?.installedThemeIds ? [...new Set(patch.appearance.installedThemeIds)] : [...base.appearance.installedThemeIds],
    customThemes: patch.appearance?.customThemes ? [...patch.appearance.customThemes] : [...base.appearance.customThemes],
    surfacePackId: patch.appearance?.surfacePackId ?? base.appearance.surfacePackId,
    surface: { ...base.appearance.surface, ...(patch.appearance?.surface ?? {}) },
    installedSurfacePackIds: patch.appearance?.installedSurfacePackIds ? [...new Set(patch.appearance.installedSurfacePackIds)] : [...base.appearance.installedSurfacePackIds],
    customSurfacePacks: patch.appearance?.customSurfacePacks ? [...patch.appearance.customSurfacePacks] : [...base.appearance.customSurfacePacks],
    looks: patch.appearance?.looks ? [...patch.appearance.looks] : [...base.appearance.looks],
    activeLookId: patch.appearance?.activeLookId ?? base.appearance.activeLookId,
    priorityColors: isRecord(patch.appearance) && isRecord(patch.appearance.priorityColors)
      ? { ...base.appearance.priorityColors, ...patch.appearance.priorityColors }
      : { ...base.appearance.priorityColors },
    zoomFactor: typeof patch.appearance?.zoomFactor === 'number'
      ? Math.min(1.5, Math.max(0.7, Math.round(patch.appearance.zoomFactor * 10) / 10))
      : base.appearance.zoomFactor
  };
  mirrorActiveLook(appearance, patch);

  const terminal: TerminalSettings = {
    ...base.terminal,
    ...(patch.terminal ?? {})
  };
  const git: GitSettings = { ...base.git, ...(patch.git ?? {}) };
  const gitVisual: GitVisualSettings = { ...base.gitVisual, ...(patch.gitVisual ?? {}) };
  const mobileAccess: MobileAccessSettings = { ...base.mobileAccess, ...(patch.mobileAccess ?? {}) };

  return {
    ai,
    jira,
    performance,
    delivery,
    mcpServer,
    startup,
    marketplace,
    preview,
    appearance,
    terminal,
    git,
    gitVisual,
    mobileAccess
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
