import type { MobileAppearance, MobileAppearanceColors, MobileMotif, MobileMotifAnchor, MobileMotifLayer } from '@praxis/core';
import { allThemes } from './themes';
import { splitCssLayers } from './cssLayerList';

/** The desktop token each phone colour is read from. */
const TOKENS: Record<keyof MobileAppearanceColors, string> = {
  bg: '--bg',
  bgElevated: '--bg-elevated',
  bgSunken: '--bg-sunken',
  bgInput: '--bg-input',
  border: '--border',
  borderStrong: '--border-strong',
  text: '--text',
  textSecondary: '--text-secondary',
  textTertiary: '--text-tertiary',
  accent: '--accent',
  accentContrast: '--accent-contrast',
  success: '--success',
  warning: '--warning',
  danger: '--danger',
};

interface Rgba { r: number; g: number; b: number; a: number }

/**
 * Parses a computed colour. Chromium reports `rgb()`/`rgba()`, or
 * `color(srgb …)` for a token built with `color-mix()`.
 */
function parseComputedColor(value: string): Rgba | undefined {
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(value.trim());
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: alpha };
  }
  const srgb = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(value.trim());
  if (srgb) {
    const alpha = srgb[4] === undefined ? 1 : srgb[4].endsWith('%') ? parseFloat(srgb[4]) / 100 : parseFloat(srgb[4]);
    return { r: +srgb[1] * 255, g: +srgb[2] * 255, b: +srgb[3] * 255, a: alpha };
  }
  return undefined;
}

function toHex({ r, g, b }: Rgba): string {
  const channel = (value: number): string => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** A translucent token is flattened over the page background, which is how it reads on screen. */
function over(top: Rgba, base: Rgba): Rgba {
  return { r: top.r * top.a + base.r * (1 - top.a), g: top.g * top.a + base.g * (1 - top.a), b: top.b * top.a + base.b * (1 - top.a), a: 1 };
}

const ANCHOR_BY_POSITION: Record<string, MobileMotifAnchor> = {
  'left top': 'top-left',
  'right top': 'top-right',
  'left bottom': 'bottom-left',
  'right bottom': 'bottom-right',
};

/**
 * The motif exactly as `applySurfacePack` painted it: the same SVG images,
 * sizes and corners, and the strength the watermark layer computes to. Motion
 * is left out — the phone draws the resting frame — so any reveal `<style>` is
 * dropped. Undefined when no motif is painted.
 */
function resolveMobileMotif(root: HTMLElement): MobileMotif | undefined {
  const style = root.style;
  const images = splitCssLayers(style.getPropertyValue('--surface-watermark-image'));
  if (!images.length || images[0] === 'none') return undefined;
  const sizes = splitCssLayers(style.getPropertyValue('--surface-watermark-size'));
  const positions = splitCssLayers(style.getPropertyValue('--surface-watermark-position'));
  const repeats = splitCssLayers(style.getPropertyValue('--surface-watermark-repeat'));
  const number = (name: string, fallback: number): number => {
    const value = parseFloat(style.getPropertyValue(name));
    return Number.isFinite(value) ? value : fallback;
  };
  const opacity = number('--surface-watermark-opacity', 0) * number('--surface-intensity', 1) * number('--surface-texture', 1);
  if (!(opacity > 0)) return undefined;
  const layers: MobileMotifLayer[] = [];
  images.forEach((image, index) => {
    const data = /^url\("data:image\/svg\+xml,(.*)"\)$/.exec(image);
    const size = /^([\d.]+)px\s+([\d.]+)px$/.exec(sizes[index] ?? '');
    if (!data || !size) return;
    const svg = decodeURIComponent(data[1]).replace(/<style>[\s\S]*?<\/style>/g, '');
    const repeat = (repeats[index] ?? 'no-repeat') === 'repeat';
    layers.push({
      svg,
      width: parseFloat(size[1]),
      height: parseFloat(size[2]),
      anchor: repeat ? 'center' : ANCHOR_BY_POSITION[positions[index] ?? ''] ?? 'top-right',
      repeat,
    });
  });
  return layers.length
    ? { opacity: Math.min(1, opacity), layers, viewport: { width: window.innerWidth, height: window.innerHeight } }
    : undefined;
}

/** The theme this window is wearing, read from the live tokens so custom and marketplace themes resolve too. */
function resolveMobileAppearance(): MobileAppearance | undefined {
  const root = document.documentElement;
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  try {
    const read = (token: string): Rgba | undefined => {
      probe.style.color = '';
      probe.style.color = `var(${token})`;
      return parseComputedColor(getComputedStyle(probe).color);
    };
    const bg = read('--bg');
    if (!bg) return undefined;
    const colors = {} as MobileAppearanceColors;
    for (const [key, token] of Object.entries(TOKENS) as [keyof MobileAppearanceColors, string][]) {
      const color = read(token);
      if (!color) return undefined;
      colors[key] = toHex(color.a < 1 ? over(color, bg) : color);
    }
    const themeId = root.getAttribute('data-theme') ?? 'praxis-light';
    const motif = resolveMobileMotif(root);
    return {
      themeId,
      themeName: allThemes().find(theme => theme.id === themeId)?.name ?? themeId,
      mode: root.getAttribute('data-mode') === 'light' ? 'light' : 'dark',
      colors,
      ...(motif ? { motif } : {}),
    };
  } finally {
    probe.remove();
  }
}

/**
 * Tells the desktop host which theme and motif this window applied, now and
 * on every change, so paired phones wear the same one. Resolution waits a frame so the
 * new `data-theme` tokens have taken effect.
 */
export function startPublishingMobileAppearance(): void {
  let frame: number | undefined;
  const publish = (): void => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = undefined;
      const appearance = resolveMobileAppearance();
      if (appearance) void window.praxis.settings.publishMobileAppearance(appearance).catch(() => undefined);
    });
  };
  window.addEventListener('tm-theme-changed', publish);
  // The motif is re-baked on every surface change (pack, dials, motif override).
  window.addEventListener('tm-surface-changed', publish);
  publish();
}
