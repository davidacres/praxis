/**
 * Shared types for the add-on marketplace.
 *
 * An **add-on** is a small package published to a GitHub Packages npm registry
 * whose `package.json` carries a `praxis` block (the {@link AddonManifest}) and
 * whose tarball unpacks a kind-specific payload under `package/addon/`. Praxis
 * discovers add-ons by listing the owner's npm packages through the GitHub
 * REST API, filtered by a name prefix.
 *
 * Five kinds are installable. `theme`, `surface-pack` and `workflow-template`
 * are declarative data and activate on install. `agent` and `skill` ship
 * executable intent (prompts, instructions, and — for a skill — optional
 * scripts/references) and install **disabled** until the user grants trust.
 */

export type AddonKind = 'theme' | 'surface-pack' | 'agent' | 'skill' | 'workflow-template';

export const ADDON_KINDS: readonly AddonKind[] = [
  'theme',
  'surface-pack',
  'agent',
  'skill',
  'workflow-template'
];

/** Kinds whose content only describes appearance/config and is safe to activate immediately. */
export const DECLARATIVE_ADDON_KINDS: readonly AddonKind[] = ['theme', 'surface-pack', 'workflow-template'];

export function isAddonKind(value: unknown): value is AddonKind {
  return typeof value === 'string' && (ADDON_KINDS as readonly string[]).includes(value);
}

/** The relative path, inside the npm tarball's `package/` root, that holds the payload. */
export const ADDON_PAYLOAD_DIR = 'addon';

/** File written alongside an unpacked payload recording how it was installed. */
export const INSTALL_RECORD_FILE = '.praxis-addon.json';

/**
 * The `praxis` block every add-on package declares in its `package.json`. Held
 * there (not only in the tarball) so the browse list can be built from registry
 * metadata without downloading anything.
 */
export interface AddonManifest {
  schemaVersion: 1;
  kind: AddonKind;
  /** Stable identity within a kind. Lower-kebab, `[a-z0-9]` start, ≤ 64 chars. */
  id: string;
  /** Display name, ≤ 80 chars. */
  name: string;
  /** One-line description shown in the catalogue. */
  summary?: string;
  /**
   * Semver of the add-on *content*. Usually mirrors the npm package version;
   * kept separate so a packaging-only re-publish need not bump it.
   */
  contentVersion?: string;
  /** Lowest Praxis app version this add-on supports (semver). */
  minAppVersion?: string;
  author?: string;
  homepage?: string;
  /**
   * Optional display hints the per-kind marketplace UI can render *before* the
   * add-on is installed (the payload isn't downloaded for the browse list). A
   * `theme` add-on puts its preview colours + mode here so its catalogue card
   * looks like a real theme card; a `surface-pack` can supply a `preview`
   * swatch the same way. Unknown keys are ignored.
   */
  display?: {
    /** Preview colour tokens (`canvas`, `panel`, `accent`, …). */
    preview?: Record<string, string>;
    /** For a theme: which appearance mode the preview represents. */
    mode?: 'light' | 'dark';
  };
}

/** One installable add-on, resolved from a registry package's latest version. */
export interface CatalogEntry {
  manifest: AddonManifest;
  /** npm package name on the registry. */
  packageName: string;
  /** Version tagged `latest` (what an install without a pin resolves to). */
  latestVersion: string;
  /** Every published version, newest first. */
  versions: string[];
  /** Publish time of `latestVersion`, when the registry reports it. */
  updatedAt?: string;
  /**
   * True when `manifest.minAppVersion` is higher than the running app. Still
   * listed, so the user can see it exists, but not installable.
   */
  incompatible: boolean;
  /** Non-blocking notes (missing summary, higher app version required, …). */
  warnings: string[];
}

/** Recorded on disk ({@link INSTALL_RECORD_FILE}) for each installed add-on. */
export interface InstalledAddon {
  manifest: AddonManifest;
  packageName: string;
  /** The exact version that was unpacked. */
  version: string;
  /** SRI string the registry advertised and that was verified at install. */
  integrity?: string;
  /** ISO-8601. */
  installedAt: string;
  /**
   * Whether the add-on is active. Declarative kinds are always `true`; an
   * `agent` is `false` until the user grants execution trust.
   */
  enabled: boolean;
}

/**
 * The `addon/theme.json` payload of a `theme` add-on — the same shape the
 * renderer's `registerCustomThemes` consumes, so an installed theme joins the
 * gallery through the existing custom-theme path.
 */
export interface AddonThemeContent {
  id: string;
  name: string;
  mode: 'light' | 'dark';
  description: string;
  /** Theme preview colour tokens (canvas, panel, accent, …). */
  preview: Record<string, string>;
  /** Optional 16-colour ANSI palette for the integrated terminal. */
  terminal?: Record<string, string>;
}

/** The `addon/pack.json` payload of a `surface-pack` add-on. */
export interface AddonSurfacePackContent {
  id: string;
  name: string;
  description: string;
  /** Built-in pack to inherit `[data-surface]` styling from. */
  basePackId?: string;
  /** `--surface-*` overrides; the renderer filters these against its whitelist. */
  tokens: Record<string, string>;
  /** Watermark pattern spec; the renderer ignores unknown pattern ids. */
  pattern?: Record<string, unknown>;
}

/** Declarative appearance content contributed by enabled add-ons. */
export interface ActiveAppearanceAddons {
  themes: AddonThemeContent[];
  surfacePacks: AddonSurfacePackContent[];
}

/** An installed add-on that has a newer version available. */
export interface AddonUpdate {
  id: string;
  kind: AddonKind;
  packageName: string;
  installedVersion: string;
  latestVersion: string;
}
