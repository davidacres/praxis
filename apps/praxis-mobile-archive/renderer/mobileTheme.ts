import type { MobileAppearance, MobileMotif, MobileMotifAnchor, MobileMotifLayer } from '@praxis/core';

/** Every colour the phone paints with. The desktop's theme is mapped onto these names. */
export interface MobilePalette {
  bg: string;
  bgSunken: string;
  surface: string;
  surfaceRaised: string;
  input: string;
  userMessage: string;
  assistantMessage: string;
  border: string;
  borderStrong: string;
  text: string;
  textSecondary: string;
  textDim: string;
  accent: string;
  accentSoft: string;
  accentMuted: string;
  ok: string;
  warn: string;
  danger: string;
  /** Translucent chrome over the hex backdrop, and the modal scrim. */
  chrome: string;
  hexShade: string;
  scrim: string;
  warnSoft: string;
  dangerSoft: string;
  camera: string;
  onAccent: string;
}

/** What the phone wears before it has ever heard from a desktop: Praxis Dark. */
export const DEFAULT_MOBILE_PALETTE: MobilePalette = paletteFromAppearance({
  themeId: 'praxis-dark',
  themeName: 'Praxis Dark',
  mode: 'dark',
  colors: {
    bg: '#100e0b', bgElevated: '#2c2620', bgSunken: '#0b0907', bgInput: '#211c17',
    border: '#443a30', borderStrong: '#6c5b4a', text: '#f0e7d8', textSecondary: '#cdbfae',
    textTertiary: '#958878', accent: '#c6431f', accentContrast: '#fffdf8',
    success: '#3fb950', warning: '#d29922', danger: '#e2766d',
  },
});

const COLOR_KEYS = [
  'bg', 'bgElevated', 'bgSunken', 'bgInput', 'border', 'borderStrong', 'text', 'textSecondary',
  'textTertiary', 'accent', 'accentContrast', 'success', 'warning', 'danger',
] as const;
const HEX = /^#[0-9a-f]{6}$/;

/**
 * A well-formed desktop appearance, or undefined. The desktop already
 * validates what it sends; this re-checks what comes off the wire or out of
 * storage before it is painted (core is type-only on the phone, so this
 * mirrors its `normalizeMobileAppearance`).
 */
export function readMobileAppearance(value: unknown): MobileAppearance | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<MobileAppearance>;
  if (typeof candidate.themeId !== 'string' || !candidate.themeId) return undefined;
  if (candidate.mode !== 'light' && candidate.mode !== 'dark') return undefined;
  const colors = candidate.colors as Record<string, unknown> | undefined;
  if (!colors || COLOR_KEYS.some(key => typeof colors[key] !== 'string' || !HEX.test(colors[key] as string))) return undefined;
  const picked = Object.fromEntries(COLOR_KEYS.map(key => [key, colors[key]])) as unknown as MobileAppearance['colors'];
  const motif = readMobileMotif(candidate.motif);
  return {
    themeId: candidate.themeId,
    themeName: typeof candidate.themeName === 'string' && candidate.themeName ? candidate.themeName : candidate.themeId,
    mode: candidate.mode,
    colors: picked,
    ...(motif ? { motif } : {}),
  };
}

const ANCHORS: readonly MobileMotifAnchor[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];

/** The desktop's motif, or undefined when it is missing or malformed (the colours still apply). */
function readMobileMotif(value: unknown): MobileMotif | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<MobileMotif>;
  if (typeof candidate.opacity !== 'number' || !(candidate.opacity > 0) || !Array.isArray(candidate.layers)) return undefined;
  const size = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= 4000;
  const layers: MobileMotifLayer[] = [];
  for (const layer of candidate.layers.slice(0, 4) as Partial<MobileMotifLayer>[]) {
    if (!layer || typeof layer.svg !== 'string' || !layer.svg.startsWith('<svg') || layer.svg.length > 200_000) return undefined;
    if (!ANCHORS.includes(layer.anchor as MobileMotifAnchor) || !size(layer.width) || !size(layer.height)) return undefined;
    layers.push({ svg: layer.svg, width: layer.width, height: layer.height, anchor: layer.anchor as MobileMotifAnchor, repeat: layer.repeat === true });
  }
  const viewport = candidate.viewport;
  const fits = viewport && [viewport.width, viewport.height].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 100 && n <= 10_000);
  return layers.length
    ? { opacity: Math.min(1, candidate.opacity), layers, ...(fits ? { viewport: { width: viewport!.width, height: viewport!.height } } : {}) }
    : undefined;
}

/**
 * How far to shrink a corner motif's spread on a screen of `width × height`,
 * so it covers the same share of the phone as it does of the desktop window.
 * The cells keep their size — only the reach of each corner shrinks.
 */
export function motifSpreadScale(motif: MobileMotif, width: number, height: number): number {
  if (!motif.viewport || width <= 0 || height <= 0) return 1;
  const ratio = (width + height) / (motif.viewport.width + motif.viewport.height);
  return Math.min(1, Math.max(0.2, ratio));
}

/**
 * A corner layer redrawn with a smaller spread. A lattice's box, mask and
 * filled area are all the spread square, so they shrink together while the
 * repeating cell keeps its size; an emblem (no lattice) is scaled whole.
 */
export function fitCornerMotifSvg(layer: MobileMotifLayer, scale: number): { svg: string; size: number } {
  const size = Math.round(layer.width * scale);
  if (scale >= 1) return { svg: layer.svg, size: layer.width };
  if (!layer.svg.includes('id="sp"')) {
    return { svg: layer.svg.replace(/^<svg([^>]*?) width="[\d.]+" height="[\d.]+"/, `<svg$1 width="${size}" height="${size}"`), size };
  }
  const spread = String(layer.width);
  const svg = layer.svg
    .replace(`viewBox="0 0 ${spread} ${spread}"`, `viewBox="0 0 ${size} ${size}"`)
    .split(`width="${spread}" height="${spread}"`).join(`width="${size}" height="${size}"`);
  return { svg, size };
}

/**
 * A repeating layer as one SVG covering `width × height`: the tile's own
 * content moved into a `<pattern>`, so it repeats the way the desktop's CSS
 * background does.
 */
export function tiledMotifSvg(layer: MobileMotifLayer, width: number, height: number): string {
  const inner = layer.svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<defs><pattern id="mt" width="${layer.width}" height="${layer.height}" patternUnits="userSpaceOnUse">${inner}</pattern></defs>` +
    `<rect width="${width}" height="${height}" fill="url(#mt)"/></svg>`;
}

function channels(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** `amount` of `top` over `base`, as `#rrggbb`. */
export function mixHex(base: string, top: string, amount: number): string {
  const a = channels(base);
  const b = channels(top);
  return `#${a.map((value, index) => Math.round(value + (b[index]! - value) * amount).toString(16).padStart(2, '0')).join('')}`;
}

function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = channels(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The phone palette for a desktop theme. Surfaces and text come straight from
 * the desktop's tokens; the tints the desktop builds with translucency (soft
 * accent, message bubbles, warning wells) are mixed into the background here,
 * because each phone surface is painted as one flat colour.
 */
export function paletteFromAppearance(appearance: MobileAppearance): MobilePalette {
  const c = appearance.colors;
  const light = appearance.mode === 'light';
  return {
    bg: c.bg,
    bgSunken: c.bgSunken,
    surface: c.bgElevated,
    surfaceRaised: mixHex(c.bgElevated, c.text, light ? 0.05 : 0.07),
    input: c.bgInput,
    userMessage: mixHex(c.bgElevated, c.accent, light ? 0.12 : 0.2),
    assistantMessage: c.bgElevated,
    border: c.border,
    borderStrong: c.borderStrong,
    text: c.text,
    textSecondary: c.textSecondary,
    textDim: c.textTertiary,
    accent: c.accent,
    accentSoft: mixHex(c.bg, c.accent, light ? 0.12 : 0.2),
    accentMuted: mixHex(c.bg, c.accent, light ? 0.3 : 0.5),
    ok: c.success,
    warn: c.warning,
    danger: c.danger,
    chrome: withAlpha(c.bgSunken, 0.95),
    hexShade: withAlpha(c.bgSunken, light ? 0.35 : 0.18),
    scrim: light ? 'rgba(0, 0, 0, 0.38)' : 'rgba(0, 0, 0, 0.62)',
    warnSoft: mixHex(c.bg, c.warning, light ? 0.14 : 0.2),
    dangerSoft: mixHex(c.bg, c.danger, light ? 0.12 : 0.2),
    camera: '#000000',
    onAccent: c.accentContrast,
  };
}
