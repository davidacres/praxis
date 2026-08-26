export type ThemeMode = 'light' | 'dark';
export type ThemeModePreference = ThemeMode | 'system';

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
  family: 'Ticket Manager' | 'Inspired palettes';
  section: 'Recent' | 'Staff picks';
  source?: 'built-in' | 'marketplace';
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
    id: 'tm-default-1', name: 'TMDefault1', family: 'Ticket Manager', section: 'Recent', mode: 'light',
    description: 'The original Ticket Manager light palette.',
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
    id: 'tm-default-2', name: 'TMDefault2', family: 'Ticket Manager', section: 'Recent', mode: 'dark',
    description: 'The original Ticket Manager dark palette.',
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

export const DEFAULT_THEME_ID = 'tm-default-2';

export function getInitialThemeId(): string {
  const saved = localStorage.getItem('tm-theme-id');
  if (saved && THEMES.some(theme => theme.id === saved)) return saved;
  return localStorage.getItem('tm-theme-mode') === 'light' ? 'tm-default-1' : DEFAULT_THEME_ID;
}

export function applyTheme(themeId: string, modeOverride?: ThemeMode): ThemeDefinition {
  const theme = THEMES.find(candidate => candidate.id === themeId) ?? THEMES.find(candidate => candidate.id === DEFAULT_THEME_ID)!;
  document.documentElement.setAttribute('data-theme', theme.id);
  document.documentElement.setAttribute('data-mode', modeOverride ?? theme.mode);
  localStorage.setItem('tm-theme-id', theme.id);
  localStorage.setItem('tm-theme-mode', modeOverride ?? theme.mode);
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
    const base = THEMES.find(candidate => candidate.id === themeId) ?? THEMES.find(candidate => candidate.id === DEFAULT_THEME_ID)!;
    const family = base.id.replace(/-(?:light|dark|1|2)$/, '');
    const variant = THEMES.find(candidate => candidate.id === `${family}-${mode}`)
      ?? (family === 'tm-default' ? THEMES.find(candidate => candidate.id === (mode === 'light' ? 'tm-default-1' : 'tm-default-2')) : undefined)
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
  const theme = THEMES.find(candidate => candidate.id === themeId && candidate.mode === mode)
    ?? THEMES.find(candidate => candidate.id === themeId);
  return theme?.terminal;
}
