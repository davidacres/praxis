export type ThemeMode = 'light' | 'dark';
export type ThemeModePreference = ThemeMode | 'system';
import type { AppearanceSettings } from '@praxis/core';
import { DEFAULT_SURFACE_PACK_ID, findSurfacePack, type SurfacePackDefinition } from './surfacePacks';
import {
  perceptualOpacityScale, resolveSurfacePattern,
  type SurfacePatternInk, type SurfacePatternSpec
} from './surfacePatterns';

export interface ThemePreviewColors {
  canvas: string;
  panel: string;
  raised: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  family: 'Praxis' | 'Inspired palettes';
  section: 'Recent' | 'Staff picks';
  source?: 'built-in' | 'marketplace' | 'custom';
  mode: ThemeMode;
  description: string;
  preview: ThemePreviewColors;
  /** ANSI palette used by the integrated terminal for this visual family. */
  terminal?: { black: string; red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string; white: string; brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string; brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string };
}

// Every other theme (GitHub, Anthropic, Humanist, Jira Cloud, VS Code, Xcode,
// Dracula, Nord, and the rest of what used to live here as a hardcoded
// `source: 'marketplace'` fallback with no real package behind it) is now a
// real GitHub Packages add-on under the same names/ids, browsable from the
// Themes panel's Marketplace section. Only Praxis's own four ship built-in.
const BUILT_IN_THEMES: ThemeDefinition[] = [
  {
    id: 'praxis-light', name: 'Praxis Light', family: 'Praxis', section: 'Recent', mode: 'light',
    description: 'Warm parchment surfaces with the original Praxis terracotta accent.',
    preview: { canvas: '#f5f2eb', panel: '#fffdf8', raised: '#ebe7de', border: '#d5c8b8', text: '#2c2620', muted: '#74695e', accent: '#c6431f', success: '#467a5b', warning: '#9b6b22', danger: '#b94a48' }
  },
  {
    id: 'praxis-dark', name: 'Praxis Dark', family: 'Praxis', section: 'Recent', mode: 'dark',
    description: 'The original Praxis splash palette: warm charcoal, parchment, and terracotta.',
    preview: { canvas: '#100e0b', panel: '#2c2620', raised: '#0b0907', border: '#443a30', text: '#f0e7d8', muted: '#cdbfae', accent: '#c6431f', success: '#7aa88d', warning: '#d4a27f', danger: '#e2766d' }
  },
  {
    id: 'tm-default-1', name: 'TMDefault1', family: 'Praxis', section: 'Recent', mode: 'light',
    description: 'The original Praxis light palette.',
    preview: { canvas: '#f6f6f6', panel: '#ffffff', raised: '#ececec', border: '#cdcdcd', text: '#1f1f1f', muted: '#8b8b8b', accent: '#7c5cff', success: '#3fb950', warning: '#d29922', danger: '#b52d2d' }
  },
  {
    id: 'tm-default-2', name: 'TMDefault2', family: 'Praxis', section: 'Recent', mode: 'dark',
    description: 'The original Praxis dark palette.',
    preview: { canvas: '#1c1c1c', panel: '#202020', raised: '#181818', border: '#3d3d3d', text: '#e4e4e4', muted: '#858585', accent: '#7c5cff', success: '#3fb950', warning: '#d29922', danger: '#f47067' }
  },
  {
    id: 'simple', name: 'Simple', family: 'Praxis', section: 'Recent', mode: 'dark',
    description: 'Clean, minimalist dark palette inspired by Orca with neutral charcoals and crisp contrast.',
    preview: { canvas: '#0a0a0a', panel: '#171717', raised: '#141414', border: '#2a2a2a', text: '#fafafa', muted: '#888888', accent: '#ffffff', success: '#10b981', warning: '#f59e0b', danger: '#ef4444' }
  }
];

export const THEMES: ThemeDefinition[] = [...BUILT_IN_THEMES];
export const BUILT_IN_THEME_IDS = BUILT_IN_THEMES.map(theme => theme.id);
const THEME_PREVIEW_FALLBACK = { canvas: '#1c1c1c', panel: '#202020', raised: '#181818', border: '#3d3d3d', text: '#e4e4e4', muted: '#858585', accent: '#7c5cff', success: '#3fb950', warning: '#d29922', danger: '#f47067' };

let customThemes: ThemeDefinition[] = [];
// Themes installed from the add-on marketplace. Kept in their own bucket so
// `registerCustomThemes` (called from the Themes editor with just the user's
// own drafts) never clears them, and vice versa.
let installedAddonThemes: ThemeDefinition[] = [];

export function registerCustomThemes(records: AppearanceSettings['customThemes']): void {
  customThemes = records.map(record => ({ ...record, family: 'Praxis' as const, section: 'Recent' as const, source: 'custom' as const, preview: { ...THEME_PREVIEW_FALLBACK, ...record.preview } as ThemePreviewColors }));
}

export function registerMarketplaceThemes(records: AppearanceSettings['customThemes']): void {
  installedAddonThemes = records.map(record => ({ ...record, family: 'Inspired palettes' as const, section: 'Recent' as const, source: 'marketplace' as const, preview: { ...THEME_PREVIEW_FALLBACK, ...record.preview } as ThemePreviewColors }));
}

function findTheme(themeId: string): ThemeDefinition | undefined {
  return (
    THEMES.find(theme => theme.id === themeId) ??
    customThemes.find(theme => theme.id === themeId) ??
    installedAddonThemes.find(theme => theme.id === themeId)
  );
}

export function allThemes(): ThemeDefinition[] {
  return [...THEMES, ...customThemes, ...installedAddonThemes];
}

// The single hardcoded fallback: what renders before anything else can be
// resolved (a fresh profile, an unrecognised saved id, a marketplace theme
// whose add-on is no longer installed). Deliberately just one theme, not a
// light/dark pair, so there is exactly one thing to reason about when nothing
// else loaded.
export const DEFAULT_THEME_ID = 'praxis-light';

export function getInitialThemeId(): string {
  const saved = localStorage.getItem('tm-theme-id');
  if (saved && findTheme(saved)) return saved;
  return DEFAULT_THEME_ID;
}

export function applyTheme(themeId: string, modeOverride?: ThemeMode): ThemeDefinition {
  const theme = findTheme(themeId) ?? findTheme(DEFAULT_THEME_ID)!;
  document.documentElement.setAttribute('data-theme', theme.id);
  document.documentElement.setAttribute('data-mode', modeOverride ?? theme.mode);
  const customTokens = ['--bg', '--bg-elevated', '--bg-sunken', '--bg-input', '--border', '--border-strong', '--text', '--text-secondary', '--text-tertiary', '--accent', '--accent-hover', '--accent-soft', '--accent-border', '--accent-contrast', '--danger'];
  for (const token of customTokens) document.documentElement.style.removeProperty(token);
  localStorage.setItem('tm-theme-id', theme.id);
  localStorage.setItem('tm-theme-mode', modeOverride ?? theme.mode);
  if (theme.source === 'custom') {
    const colors = theme.preview;
    const root = document.documentElement;
    root.style.setProperty('--bg', colors.canvas);
    root.style.setProperty('--bg-elevated', colors.panel);
    root.style.setProperty('--bg-sunken', colors.raised);
    root.style.setProperty('--bg-input', colors.panel);
    root.style.setProperty('--border', colors.border);
    root.style.setProperty('--border-strong', colors.border);
    root.style.setProperty('--text', colors.text);
    root.style.setProperty('--text-secondary', colors.muted);
    root.style.setProperty('--text-tertiary', colors.muted);
    root.style.setProperty('--accent', colors.accent);
    root.style.setProperty('--accent-hover', colors.accent);
    root.style.setProperty('--accent-soft', `${colors.accent}2b`);
    root.style.setProperty('--accent-border', `${colors.accent}80`);
    root.style.setProperty('--accent-contrast', modeOverride === 'light' ? '#111111' : '#ffffff');
    root.style.setProperty('--danger', colors.danger);
  }
  window.dispatchEvent(new CustomEvent('tm-theme-changed', { detail: theme.id }));
  return theme;
}

export function resolveThemeMode(preference: ThemeModePreference): ThemeMode {
  if (preference !== 'system') return preference;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

let systemThemeListener: (() => void) | undefined;
export function applyThemePreference(themeId: string, preference: ThemeModePreference): ThemeDefinition {
  systemThemeListener?.();
  systemThemeListener = undefined;
  const apply = () => {
    const mode = resolveThemeMode(preference);
    const base = findTheme(themeId) ?? findTheme(DEFAULT_THEME_ID)!;
    const family = base.id.replace(/-(?:light|dark|1|2)$/, '');
    const variant = findTheme(`${family}-${mode}`)
      ?? (family === 'tm-default' ? findTheme(mode === 'light' ? 'tm-default-1' : 'tm-default-2') : undefined)
      ?? base;
    return applyTheme(variant.id, mode);
  };
  const theme = apply();
  if (preference === 'system' && window.matchMedia) {
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const listener = () => apply();
    query.addEventListener?.('change', listener);
    systemThemeListener = () => query.removeEventListener?.('change', listener);
  }
  return theme;
}

export function terminalColorsForTheme(themeId: string, mode: ThemeMode): ThemeDefinition['terminal'] {
  const theme = allThemes().find(candidate => candidate.id === themeId && candidate.mode === mode)
    ?? findTheme(themeId);
  return theme?.terminal;
}

/* ── Surface packs ─────────────────────────────────────────────────────────
   The premium material layer, applied on the independent `data-surface` axis.
   It composes with whatever theme is active and survives theme changes, so it
   has its own apply function and localStorage keys mirroring the theme ones. */

export interface SurfaceOpts {
  /** 0..1 multiplier on texture strength / glow. */
  intensity: number;
  /** Gate the texture / grain layers. */
  texture: boolean;
  /** Gate the translucency / backdrop-blur path (phase 2+). */
  translucency: boolean;
  /** Opt in to native OS window vibrancy behind a glass pack (phase 3+). */
  windowVibrancy: boolean;
  /**
   * Master gate on motif motion, the way `texture` gates the grain. The motif's
   * own `animation` style picks which movement; this switches all of it off.
   */
  animateMotifs: boolean;
  /**
   * The user's Motif override. The motif is independent of the material: a pack
   * ships a sensible default, and anything set here wins, so a hexagon can be
   * worn over any theme *and* any material. Undefined fields fall back to the
   * pack's own pattern, so a partial override (say, just a colour) still works.
   */
  motif?: Partial<SurfacePatternSpec>;
}

const DEFAULT_SURFACE_OPTS: SurfaceOpts = { intensity: 1, texture: true, translucency: true, windowVibrancy: false, animateMotifs: true };

export function getInitialSurfaceId(): string {
  const saved = localStorage.getItem('tm-surface-id');
  return saved && findSurfacePack(saved) ? saved : DEFAULT_SURFACE_PACK_ID;
}

export function getInitialSurfaceOpts(): SurfaceOpts {
  try {
    const raw = JSON.parse(localStorage.getItem('tm-surface-opts') ?? '{}') as Partial<SurfaceOpts>;
    return {
      intensity: typeof raw.intensity === 'number' && raw.intensity >= 0 && raw.intensity <= 1
        ? raw.intensity : DEFAULT_SURFACE_OPTS.intensity,
      texture: typeof raw.texture === 'boolean' ? raw.texture : DEFAULT_SURFACE_OPTS.texture,
      translucency: typeof raw.translucency === 'boolean' ? raw.translucency : DEFAULT_SURFACE_OPTS.translucency,
      windowVibrancy: typeof raw.windowVibrancy === 'boolean' ? raw.windowVibrancy : DEFAULT_SURFACE_OPTS.windowVibrancy,
      animateMotifs: typeof raw.animateMotifs === 'boolean' ? raw.animateMotifs : DEFAULT_SURFACE_OPTS.animateMotifs,
      motif: raw.motif && typeof raw.motif === 'object' ? raw.motif : undefined
    };
  } catch {
    return { ...DEFAULT_SURFACE_OPTS };
  }
}

/** `--surface-*` properties written inline for the active custom pack, cleared on the next apply. */
let appliedCustomTokenKeys: string[] = [];

function prefersReducedTransparency(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-transparency: reduce)').matches;
}

/**
 * Motif motion is gated HERE rather than in CSS because the reveal styles live
 * inside the motif's own SVG, and a `prefers-reduced-motion` query inside an
 * SVG-as-image is NOT honoured by the renderer — verified, not assumed. Never
 * baking the animation is the only way to respect the preference.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Resolves the live value of the theme token a pattern tints itself from. The
 * pattern SVG is a data URI, so it cannot contain `var()` — the colour has to
 * be baked in at apply time, which is why `refreshSurfacePattern` re-runs this
 * whenever the theme changes.
 */
export function resolvePatternInk(ink: SurfacePatternInk | undefined, inkColor?: string): string {
  if (ink === 'custom' && inkColor && /^#[0-9a-f]{3,8}$/i.test(inkColor.trim())) {
    return inkColor.trim();
  }
  const styles = getComputedStyle(document.documentElement);
  const token = styles.getPropertyValue(ink === 'text' ? '--text' : '--accent').trim();
  return token || '#888888';
}

/**
 * The motif actually painted: the active pack's pattern with the user's
 * override laid on top. Either alone is enough — a pack with no pattern still
 * gets one if the user picks it, and a user who changes only the colour keeps
 * everything else the pack chose.
 */
export function effectiveSurfacePattern(
  pack: SurfacePackDefinition,
  motif: Partial<SurfacePatternSpec> | undefined
): SurfacePatternSpec | undefined {
  if (!motif || Object.keys(motif).length === 0) {
    return pack.pattern;
  }
  const base = pack.pattern ?? { id: 'none', scale: 96, opacity: 0.08 };
  const merged = { ...base, ...motif } as SurfacePatternSpec;
  return merged.id ? merged : undefined;
}

/** The watermark layer's properties, written on :root by `paintSurfacePattern`. */
const WATERMARK_KEYS = [
  '--surface-watermark-image',
  '--surface-watermark-size',
  '--surface-watermark-opacity',
  '--surface-watermark-blend',
  '--surface-watermark-repeat',
  '--surface-watermark-attachment',
  '--surface-watermark-position',
  '--surface-watermark-ink',
  '--surface-watermark-anim',
  '--surface-watermark-filter',
  '--surface-watermark-mask',
  '--surface-watermark-mask-size',
  '--surface-watermark-mask-repeat',
  '--surface-watermark-mask-position',
  '--surface-watermark-flicker'
] as const;

/** Renders the effective motif into the `--surface-watermark-*` properties. */
function paintSurfacePattern(
  pack: SurfacePackDefinition,
  textureOn: boolean,
  motif: Partial<SurfacePatternSpec> | undefined,
  animateMotifs: boolean
): void {
  const root = document.documentElement;
  const base = effectiveSurfacePattern(pack, motif);
  // The single place motion is decided. Forcing the style to `none` — rather
  // than resolving it and disabling it downstream — is what keeps a still motif
  // byte-identical to the pre-animation render, and is the only thing the
  // reveal styles will respect (see `prefersReducedMotion`).
  const motionOn = animateMotifs && !prefersReducedMotion();
  const spec = base && !motionOn ? { ...base, animation: 'none' as const } : base;
  // The letterpress edge needs a tone that contrasts with the ground, so it
  // follows the mode unless the user pinned a colour: a highlight on dark, a
  // shadow on light. Resolved here because the pattern library is mode-blind.
  const withOutline = spec && spec.outline
    ? {
        ...spec,
        outlineInk: spec.outlineInk
          ?? (document.documentElement.getAttribute('data-mode') === 'light'
            ? 'rgba(0,0,0,0.85)'
            : 'rgba(255,255,255,0.9)')
      }
    : spec;
  // Normalise the declared strength against how far this theme's ink sits from
  // its panel, so 30% looks like 30% on every palette rather than ranging from
  // invisible to shouty. See `perceptualOpacityScale`.
  const patternInk = resolvePatternInk(spec?.ink, spec?.inkColor);
  const normalised = withOutline
    ? {
        ...withOutline,
        opacity: withOutline.opacity * perceptualOpacityScale(
          patternInk,
          getComputedStyle(document.documentElement).getPropertyValue('--bg-elevated').trim()
        )
      }
    : withOutline;
  const resolved = textureOn ? resolveSurfacePattern(normalised, patternInk) : undefined;
  if (!resolved) {
    for (const key of WATERMARK_KEYS) {
      root.style.removeProperty(key);
    }
    root.removeAttribute('data-motif-anim');
    return;
  }
  root.style.setProperty('--surface-watermark-image', resolved.image);
  root.style.setProperty('--surface-watermark-size', resolved.size);
  root.style.setProperty('--surface-watermark-opacity', resolved.opacity);
  root.style.setProperty('--surface-watermark-blend', resolved.blend);
  root.style.setProperty('--surface-watermark-repeat', resolved.repeat);
  root.style.setProperty('--surface-watermark-attachment', resolved.attachment);
  root.style.setProperty('--surface-watermark-position', resolved.position);
  // The ink is baked into the SVG, but a CSS glow needs it too — and it cannot
  // read a `var()` out of a data URI, so it is published as its own token.
  root.style.setProperty('--surface-watermark-ink', patternInk);
  root.style.setProperty('--surface-watermark-anim', resolved.anim);
  root.style.setProperty('--surface-watermark-filter', resolved.filter);
  root.style.setProperty('--surface-watermark-mask', resolved.mask);
  root.style.setProperty('--surface-watermark-mask-size', resolved.maskSize);
  root.style.setProperty('--surface-watermark-mask-repeat', resolved.maskRepeat);
  root.style.setProperty('--surface-watermark-mask-position', resolved.maskPosition);
  root.style.setProperty('--surface-watermark-flicker', resolved.flicker);
  if (resolved.animation === 'none') {
    root.removeAttribute('data-motif-anim');
  } else {
    root.setAttribute('data-motif-anim', resolved.animation);
  }
}

/** The pack + gates most recently applied, so a theme change can re-tint. */
let activeSurface: {
  pack: SurfacePackDefinition;
  textureOn: boolean;
  motif?: Partial<SurfacePatternSpec>;
  animateMotifs: boolean;
} | undefined;

/**
 * Re-bakes the active pattern against the current theme's tokens. Wired to
 * `tm-theme-changed` in main.tsx so switching palettes re-tints the watermark.
 */
export function refreshSurfacePattern(): void {
  if (activeSurface) {
    paintSurfacePattern(
      activeSurface.pack, activeSurface.textureOn, activeSurface.motif, activeSurface.animateMotifs
    );
  }
}

export function applySurfacePack(packId: string, opts: SurfaceOpts = DEFAULT_SURFACE_OPTS): SurfacePackDefinition {
  const pack = findSurfacePack(packId) ?? findSurfacePack('flat')!;
  const root = document.documentElement;
  root.setAttribute('data-surface', pack.id);

  const intensity = Math.min(1, Math.max(0, opts.intensity));
  // The OS "reduce transparency" setting overrides the user's translucency dial.
  // The gate is an attribute (data-translucency) rather than a --var so the glass
  // packs can express literal backdrop-filter values — a value routed through
  // nested custom-property + calc indirection is silently dropped by Chromium.
  const translucencyOn = opts.translucency && !prefersReducedTransparency();
  root.style.setProperty('--surface-intensity', String(intensity));
  root.style.setProperty('--surface-texture', opts.texture ? '1' : '0');
  root.style.setProperty('--surface-translucency', translucencyOn ? '1' : '0');
  root.setAttribute('data-translucency', translucencyOn ? 'on' : 'off');

  // A custom pack has no [data-surface] stylesheet block — apply its validated
  // token map inline, and clear whatever the previous custom pack set. The
  // translucency dial gates the glass properties the same way it does for the
  // built-in glass packs; --surface-backdrop is derived here (it is not a
  // stored token) so a custom blur actually reaches the backdrop-filter rule.
  for (const key of appliedCustomTokenKeys) {
    root.style.removeProperty(key);
  }
  appliedCustomTokenKeys = [];
  const glassKeys = ['--surface-panel-opacity', '--surface-panel-blur', '--surface-panel-saturate'];
  if (pack.source === 'custom' && pack.tokens) {
    for (const [key, value] of Object.entries(pack.tokens)) {
      if (!translucencyOn && glassKeys.includes(key)) {
        continue;
      }
      root.style.setProperty(key, value);
      appliedCustomTokenKeys.push(key);
    }
    const blur = pack.tokens['--surface-panel-blur'];
    if (translucencyOn && blur && parseFloat(blur) > 0) {
      const saturate = pack.tokens['--surface-panel-saturate'] ?? '1';
      root.style.setProperty('--surface-backdrop', `blur(${blur}) saturate(${saturate})`);
      appliedCustomTokenKeys.push('--surface-backdrop');
    }
  }

  // Native OS translucency: only a glass pack with the dial on, and only when
  // the platform can do it. applied=false leaves the CSS faux-depth path as the
  // sole effect. The attribute drives the transparent-root rules in surfaces.css.
  const wantsVibrancy = pack.glass && opts.windowVibrancy && translucencyOn;
  const vibrancyBridge = typeof window !== 'undefined' ? window.praxis?.window : undefined;
  if (vibrancyBridge?.setSurfaceVibrancy) {
    void vibrancyBridge.setSurfaceVibrancy(wantsVibrancy ? 'glass' : 'off')
      .then(result => {
        if (result.applied && wantsVibrancy) {
          root.setAttribute('data-vibrancy', 'glass');
        } else {
          root.removeAttribute('data-vibrancy');
        }
      })
      .catch(() => root.removeAttribute('data-vibrancy'));
  } else if (!wantsVibrancy) {
    root.removeAttribute('data-vibrancy');
  }

  // The pattern is data (see surfacePatterns.ts) — resolve it to the watermark
  // properties every pane and the splash already read. Adding a material never
  // needs new CSS, only a new entry in the pattern library or a user's pick.
  activeSurface = { pack, textureOn: opts.texture, motif: opts.motif, animateMotifs: opts.animateMotifs };
  paintSurfacePattern(pack, opts.texture, opts.motif, opts.animateMotifs);

  localStorage.setItem('tm-surface-id', pack.id);
  localStorage.setItem('tm-surface-opts', JSON.stringify({
    intensity, texture: opts.texture, translucency: opts.translucency,
    windowVibrancy: opts.windowVibrancy, animateMotifs: opts.animateMotifs, motif: opts.motif
  }));
  window.dispatchEvent(new CustomEvent('tm-surface-changed', { detail: pack.id }));
  return pack;
}
