export type ThemeMode = 'light' | 'dark';
export type ThemeModePreference = ThemeMode | 'system';
import type { AppearanceSettings } from '@ticket-manager/core';
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

const ANTHROPIC_LIGHT_TERMINAL = { black: '#1f1f1f', red: '#b94a48', green: '#467a5b', yellow: '#9b6b22', blue: '#5d6fa3', magenta: '#966aa0', cyan: '#4f8585', white: '#f5f2eb', brightBlack: '#6f6b63', brightRed: '#cc5247', brightGreen: '#5d9774', brightYellow: '#b88635', brightBlue: '#7085bd', brightMagenta: '#b07fba', brightCyan: '#6aa6a0', brightWhite: '#fffdf8' };
const ANTHROPIC_DARK_TERMINAL = { black: '#191919', red: '#e2766d', green: '#7aa88d', yellow: '#d4a27f', blue: '#8fa7d6', magenta: '#c69acb', cyan: '#86bdb4', white: '#f0f0eb', brightBlack: '#85827b', brightRed: '#f28b80', brightGreen: '#9bc8a7', brightYellow: '#e7b58e', brightBlue: '#aabfe9', brightMagenta: '#ddb4df', brightCyan: '#acd9d1', brightWhite: '#fffdf8' };
const GITHUB_LIGHT_TERMINAL = { black: '#24292f', red: '#cf222e', green: '#1a7f37', yellow: '#9a6700', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#f6f8fa', brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#116329', brightYellow: '#7d4e00', brightBlue: '#0550ae', brightMagenta: '#6639ba', brightCyan: '#055d66', brightWhite: '#ffffff' };
const GITHUB_DARK_TERMINAL = { black: '#010409', red: '#f85149', green: '#3fb950', yellow: '#d29922', blue: '#2f81f7', magenta: '#a371f7', cyan: '#39c5cf', white: '#e6edf3', brightBlack: '#6e7681', brightRed: '#ff7b72', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#58a6ff', brightMagenta: '#bc8cff', brightCyan: '#56d4dd', brightWhite: '#ffffff' };

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
    id: 'anthropic-light', name: 'Anthropic Light', family: 'Inspired palettes', section: 'Staff picks', mode: 'light',
    description: 'Warm parchment surfaces, ink text, and Claude-inspired terracotta.', terminal: ANTHROPIC_LIGHT_TERMINAL,
    preview: { canvas: '#f5f2eb', panel: '#fffdf8', raised: '#ebe7de', border: '#d5d0c6', text: '#1f1f1f', muted: '#726e66', accent: '#cc785c', success: '#467a5b', warning: '#9b6b22', danger: '#b94a48' }
  },
  {
    id: 'anthropic-dark', name: 'Anthropic Dark', family: 'Inspired palettes', section: 'Staff picks', mode: 'dark',
    description: 'Deep charcoal, parchment text, and warm Claude-inspired accents.', terminal: ANTHROPIC_DARK_TERMINAL,
    preview: { canvas: '#191919', panel: '#262625', raised: '#363633', border: '#4a4945', text: '#f0f0eb', muted: '#bfbfba', accent: '#d48668', success: '#7aa88d', warning: '#d4a27f', danger: '#e2766d' }
  },
  {
    id: 'tm-default-2', name: 'TMDefault2', family: 'Praxis', section: 'Recent', mode: 'dark',
    description: 'The original Praxis dark palette.',
    preview: { canvas: '#1c1c1c', panel: '#202020', raised: '#181818', border: '#3d3d3d', text: '#e4e4e4', muted: '#858585', accent: '#7c5cff', success: '#3fb950', warning: '#d29922', danger: '#f47067' }
  },
  {
    id: 'humanist-light', name: 'Humanist Light', family: 'Inspired palettes', section: 'Staff picks', mode: 'light',
    description: 'Warm ivory, stone, and restrained terracotta.',
    preview: { canvas: '#f5f5f4', panel: '#fafaf7', raised: '#f0f0eb', border: '#bfbfba', text: '#191919', muted: '#666663', accent: '#cc785c', success: '#4f7d63', warning: '#d4a27f', danger: '#cc5247' }
  },
  {
    id: 'humanist-dark', name: 'Humanist Dark', family: 'Inspired palettes', section: 'Staff picks', mode: 'dark',
    description: 'Warm charcoal with clay and parchment accents.',
    preview: { canvas: '#191919', panel: '#262625', raised: '#40403e', border: '#666663', text: '#f0f0eb', muted: '#bfbfba', accent: '#cc785c', success: '#7aa88d', warning: '#d4a27f', danger: '#cc5247' }
  },
  {
    id: 'github-light', name: 'GitHub Light', family: 'Inspired palettes', section: 'Recent', mode: 'light',
    description: 'GitHub Primer light surfaces and semantic colors.', terminal: GITHUB_LIGHT_TERMINAL,
    preview: { canvas: '#ffffff', panel: '#f6f8fa', raised: '#f6f8fa', border: '#d0d7de', text: '#1f2328', muted: '#656d76', accent: '#0969da', success: '#1a7f37', warning: '#9a6700', danger: '#cf222e' }
  },
  {
    id: 'github-dark', name: 'GitHub Dark', family: 'Inspired palettes', section: 'Recent', mode: 'dark',
    description: 'GitHub Primer dark surfaces and semantic colors.', terminal: GITHUB_DARK_TERMINAL,
    preview: { canvas: '#0d1117', panel: '#161b22', raised: '#010409', border: '#30363d', text: '#e6edf3', muted: '#7d8590', accent: '#2f81f7', success: '#3fb950', warning: '#d29922', danger: '#f85149' }
  }
];

const MARKETPLACE_THEMES: ThemeDefinition[] = [
  { id: 'vscode-dark-plus', name: 'VS Code Dark+', family: 'Inspired palettes', section: 'Staff picks', source: 'marketplace', mode: 'dark', description: 'The familiar VS Code Dark+ workbench with its signature blue focus color.', preview: { canvas: '#1e1e1e', panel: '#252526', raised: '#181818', border: '#454545', text: '#d4d4d4', muted: '#a6a6a6', accent: '#007acc', success: '#4ec9b0', warning: '#dcdcaa', danger: '#f14c4c' }, terminal: { black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5', brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff' } },
  { id: 'vscode-light-plus', name: 'VS Code Light+', family: 'Inspired palettes', section: 'Staff picks', source: 'marketplace', mode: 'light', description: 'A clean VS Code Light+ workbench with crisp blue selection and focus states.', preview: { canvas: '#ffffff', panel: '#f3f3f3', raised: '#e8e8e8', border: '#c8c8c8', text: '#333333', muted: '#616161', accent: '#007acc', success: '#16825d', warning: '#bf8803', danger: '#e51400' }, terminal: { black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555', brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5' } },
  { id: 'xcode-light', name: 'Xcode Light', family: 'Inspired palettes', section: 'Recent', source: 'marketplace', mode: 'light', description: 'Bright macOS-native surfaces with Xcode blue and restrained source-editor contrast.', preview: { canvas: '#ffffff', panel: '#f2f2f7', raised: '#e5e5ea', border: '#c7c7cc', text: '#1d1d1f', muted: '#6e6e73', accent: '#0a84ff', success: '#248a3d', warning: '#b25000', danger: '#d70015' }, terminal: { black: '#1d1d1f', red: '#d70015', green: '#248a3d', yellow: '#b25000', blue: '#0066cc', magenta: '#8944ab', cyan: '#0071a4', white: '#f2f2f7', brightBlack: '#6e6e73', brightRed: '#ff375f', brightGreen: '#30d158', brightYellow: '#ff9f0a', brightBlue: '#0a84ff', brightMagenta: '#bf5af2', brightCyan: '#64d2ff', brightWhite: '#ffffff' } },
  { id: 'xcode-dark', name: 'Xcode Dark', family: 'Inspired palettes', section: 'Recent', source: 'marketplace', mode: 'dark', description: 'Xcode-inspired graphite surfaces with macOS blue focus and vivid semantic colors.', preview: { canvas: '#1e1e1e', panel: '#292929', raised: '#151515', border: '#3f3f3f', text: '#f2f2f7', muted: '#98989d', accent: '#0a84ff', success: '#30d158', warning: '#ff9f0a', danger: '#ff453a' }, terminal: { black: '#000000', red: '#ff453a', green: '#30d158', yellow: '#ffd60a', blue: '#0a84ff', magenta: '#bf5af2', cyan: '#64d2ff', white: '#f2f2f7', brightBlack: '#636366', brightRed: '#ff6961', brightGreen: '#66e27f', brightYellow: '#ffe45e', brightBlue: '#409cff', brightMagenta: '#d58aff', brightCyan: '#8ee7ff', brightWhite: '#ffffff' } },
  { id: 'rider-dark', name: 'Rider Dark', family: 'Inspired palettes', section: 'Staff picks', source: 'marketplace', mode: 'dark', description: 'A Rider-inspired Darcula workspace with cool panels and confident blue focus.', preview: { canvas: '#2b2b2b', panel: '#3c3f41', raised: '#252526', border: '#515151', text: '#dfe1e5', muted: '#a9b0b8', accent: '#4a88c7', success: '#6aab73', warning: '#d6b656', danger: '#db5c5c' }, terminal: { black: '#000000', red: '#cc6666', green: '#6aab73', yellow: '#d6b656', blue: '#4a88c7', magenta: '#9876aa', cyan: '#4db6ac', white: '#dfe1e5', brightBlack: '#808080', brightRed: '#db5c5c', brightGreen: '#89c791', brightYellow: '#e8cc78', brightBlue: '#6ea6dd', brightMagenta: '#b69ac5', brightCyan: '#71d0c6', brightWhite: '#ffffff' } },
  { id: 'christmas-workshop', name: 'Christmas Workshop', family: 'Inspired palettes', section: 'Recent', source: 'marketplace', mode: 'dark', description: 'Evergreen panels, cranberry focus, candlelight gold, and snow-bright text.', preview: { canvas: '#10251b', panel: '#173326', raised: '#0b1b13', border: '#315b45', text: '#f7f2e7', muted: '#b8c8bd', accent: '#d64045', success: '#62a96b', warning: '#e0b84f', danger: '#ff6b6b' }, terminal: { black: '#08120d', red: '#d64045', green: '#62a96b', yellow: '#e0b84f', blue: '#6fa8a1', magenta: '#c77d9c', cyan: '#78c6b0', white: '#e8e1d2', brightBlack: '#547063', brightRed: '#ff6b6b', brightGreen: '#89d18f', brightYellow: '#f6d675', brightBlue: '#91c7c1', brightMagenta: '#e5a0ba', brightCyan: '#9be4d0', brightWhite: '#fffdf7' } },
  { id: 'dracula-dark', name: 'Dracula', family: 'Inspired palettes', section: 'Staff picks', source: 'marketplace', mode: 'dark', description: 'A high-contrast purple dark theme with vivid syntax colors.', preview: { canvas: '#282a36', panel: '#44475a', raised: '#21222c', border: '#6272a4', text: '#f8f8f2', muted: '#bd93f9', accent: '#ff79c6', success: '#50fa7b', warning: '#f1fa8c', danger: '#ff5555' } },
  { id: 'nord-dark', name: 'Nord', family: 'Inspired palettes', section: 'Staff picks', source: 'marketplace', mode: 'dark', description: 'Arctic blue-gray surfaces with calm frost accents.', preview: { canvas: '#2e3440', panel: '#3b4252', raised: '#242933', border: '#4c566a', text: '#eceff4', muted: '#d8dee9', accent: '#88c0d0', success: '#a3be8c', warning: '#ebcb8b', danger: '#bf616a' } },
  { id: 'one-dark', name: 'One Dark', family: 'Inspired palettes', section: 'Staff picks', source: 'marketplace', mode: 'dark', description: 'A balanced editor-dark palette inspired by Atom.', preview: { canvas: '#282c34', panel: '#21252b', raised: '#1b1d23', border: '#3e4451', text: '#abb2bf', muted: '#7f848e', accent: '#61afef', success: '#98c379', warning: '#e5c07b', danger: '#e06c75' } },
  { id: 'monokai-dark', name: 'Monokai', family: 'Inspired palettes', section: 'Staff picks', source: 'marketplace', mode: 'dark', description: 'Classic charcoal with neon pink, green, and yellow accents.', preview: { canvas: '#272822', panel: '#1e1f1c', raised: '#3e3d32', border: '#575b61', text: '#f8f8f2', muted: '#a6a6a0', accent: '#f92672', success: '#a6e22e', warning: '#e6db74', danger: '#f92672' } },
  { id: 'catppuccin-latte', name: 'Catppuccin Latte', family: 'Inspired palettes', section: 'Staff picks', source: 'marketplace', mode: 'light', description: 'Soft pastel light mode with gentle lavender accents.', preview: { canvas: '#eff1f5', panel: '#e6e9ef', raised: '#dce0e8', border: '#bcc0cc', text: '#4c4f69', muted: '#7c7f93', accent: '#8839ef', success: '#40a02b', warning: '#df8e1d', danger: '#d20f39' } },
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', family: 'Inspired palettes', section: 'Staff picks', source: 'marketplace', mode: 'dark', description: 'Soothing pastel dark mode with rich mocha surfaces.', preview: { canvas: '#1e1e2e', panel: '#181825', raised: '#313244', border: '#45475a', text: '#cdd6f4', muted: '#a6adc8', accent: '#cba6f7', success: '#a6e3a1', warning: '#f9e2af', danger: '#f38ba8' } },
  { id: 'tokyo-night', name: 'Tokyo Night', family: 'Inspired palettes', section: 'Recent', source: 'marketplace', mode: 'dark', description: 'Cool midnight blue with electric blue and purple accents.', preview: { canvas: '#1a1b26', panel: '#16161e', raised: '#24283b', border: '#3b4261', text: '#c0caf5', muted: '#565f89', accent: '#7aa2f7', success: '#9ece6a', warning: '#e0af68', danger: '#f7768e' } },
  { id: 'solarized-light', name: 'Solarized Light', family: 'Inspired palettes', section: 'Recent', source: 'marketplace', mode: 'light', description: 'Precision-calibrated warm light surfaces and blue accents.', preview: { canvas: '#fdf6e3', panel: '#eee8d5', raised: '#e4ddc8', border: '#d3cbb7', text: '#657b83', muted: '#93a1a1', accent: '#268bd2', success: '#859900', warning: '#b58900', danger: '#dc322f' } },
  { id: 'gruvbox-dark', name: 'Gruvbox Dark', family: 'Inspired palettes', section: 'Recent', source: 'marketplace', mode: 'dark', description: 'Retro warm contrast with earthy orange and green accents.', preview: { canvas: '#282828', panel: '#1d2021', raised: '#3c3836', border: '#504945', text: '#ebdbb2', muted: '#a89984', accent: '#d79921', success: '#98971a', warning: '#fabd2f', danger: '#cc241d' } },
  { id: 'ayu-light', name: 'Ayu Light', family: 'Inspired palettes', section: 'Recent', source: 'marketplace', mode: 'light', description: 'Bright neutral surfaces with a warm orange signature.', preview: { canvas: '#fafafa', panel: '#f3f3f3', raised: '#e6e6e6', border: '#d6d6d6', text: '#575f66', muted: '#8a9199', accent: '#e6a23c', success: '#86b300', warning: '#f2ae49', danger: '#f07171' } },
  { id: 'rose-pine', name: 'Rosé Pine', family: 'Inspired palettes', section: 'Recent', source: 'marketplace', mode: 'dark', description: 'Muted pine, rose, and gold tones for a calm workspace.', preview: { canvas: '#191724', panel: '#1f1d2e', raised: '#26233a', border: '#403d52', text: '#e0def4', muted: '#908caa', accent: '#ebbcba', success: '#9ccfd8', warning: '#f6c177', danger: '#eb6f92' } }
];

export const THEMES: ThemeDefinition[] = [...BUILT_IN_THEMES, ...MARKETPLACE_THEMES];
export const BUILT_IN_THEME_IDS = BUILT_IN_THEMES.map(theme => theme.id);
let customThemes: ThemeDefinition[] = [];

export function registerCustomThemes(records: AppearanceSettings['customThemes']): void {
  const fallback = { canvas: '#1c1c1c', panel: '#202020', raised: '#181818', border: '#3d3d3d', text: '#e4e4e4', muted: '#858585', accent: '#7c5cff', success: '#3fb950', warning: '#d29922', danger: '#f47067' };
  customThemes = records.map(record => ({ ...record, family: 'Praxis' as const, section: 'Recent' as const, source: 'custom' as const, preview: { ...fallback, ...record.preview } as ThemePreviewColors }));
}

function findTheme(themeId: string): ThemeDefinition | undefined {
  return THEMES.find(theme => theme.id === themeId) ?? customThemes.find(theme => theme.id === themeId);
}

export function allThemes(): ThemeDefinition[] {
  return [...THEMES, ...customThemes];
}

export const DEFAULT_THEME_ID = 'praxis-dark';

export function getInitialThemeId(): string {
  const saved = localStorage.getItem('tm-theme-id');
  if (saved && findTheme(saved)) return saved;
  return localStorage.getItem('tm-theme-mode') === 'light' ? 'tm-default-1' : DEFAULT_THEME_ID;
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
   * The user's Motif override. The motif is independent of the material: a pack
   * ships a sensible default, and anything set here wins, so a hexagon can be
   * worn over any theme *and* any material. Undefined fields fall back to the
   * pack's own pattern, so a partial override (say, just a colour) still works.
   */
  motif?: Partial<SurfacePatternSpec>;
}

const DEFAULT_SURFACE_OPTS: SurfaceOpts = { intensity: 1, texture: true, translucency: true, windowVibrancy: false };

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
  '--surface-watermark-position'
] as const;

/** Renders the effective motif into the `--surface-watermark-*` properties. */
function paintSurfacePattern(
  pack: SurfacePackDefinition,
  textureOn: boolean,
  motif: Partial<SurfacePatternSpec> | undefined
): void {
  const root = document.documentElement;
  const spec = effectiveSurfacePattern(pack, motif);
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
    return;
  }
  root.style.setProperty('--surface-watermark-image', resolved.image);
  root.style.setProperty('--surface-watermark-size', resolved.size);
  root.style.setProperty('--surface-watermark-opacity', resolved.opacity);
  root.style.setProperty('--surface-watermark-blend', resolved.blend);
  root.style.setProperty('--surface-watermark-repeat', resolved.repeat);
  root.style.setProperty('--surface-watermark-attachment', resolved.attachment);
  root.style.setProperty('--surface-watermark-position', resolved.position);
}

/** The pack + gates most recently applied, so a theme change can re-tint. */
let activeSurface: { pack: SurfacePackDefinition; textureOn: boolean; motif?: Partial<SurfacePatternSpec> } | undefined;

/**
 * Re-bakes the active pattern against the current theme's tokens. Wired to
 * `tm-theme-changed` in main.tsx so switching palettes re-tints the watermark.
 */
export function refreshSurfacePattern(): void {
  if (activeSurface) {
    paintSurfacePattern(activeSurface.pack, activeSurface.textureOn, activeSurface.motif);
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
  const vibrancyBridge = typeof window !== 'undefined' ? window.ticketManager?.window : undefined;
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
  activeSurface = { pack, textureOn: opts.texture, motif: opts.motif };
  paintSurfacePattern(pack, opts.texture, opts.motif);

  localStorage.setItem('tm-surface-id', pack.id);
  localStorage.setItem('tm-surface-opts', JSON.stringify({
    intensity, texture: opts.texture, translucency: opts.translucency,
    windowVibrancy: opts.windowVibrancy, motif: opts.motif
  }));
  window.dispatchEvent(new CustomEvent('tm-surface-changed', { detail: pack.id }));
  return pack;
}
