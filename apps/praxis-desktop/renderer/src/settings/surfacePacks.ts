/**
 * Surface packs — the premium *material* layer that composes over the colour
 * theme. A pack sets only `--surface-*` custom properties (texture, panel
 * material, translucency, glow); it never defines a colour token, so any pack
 * works over any theme. See `surfaces.css` for the `[data-surface]` blocks and
 * `applySurfacePack` in `themes.ts` for how a pack + the user dials are applied.
 *
 * Phase 1 shipped four opaque packs. Phase 2 adds the translucency packs
 * (Aurora Glass, Noir); Phase 3 wires the Aurora Glass glass path to native
 * OS window vibrancy. Phase 4 adds user-authored packs — a custom pack carries
 * its own `tokens` map (validated against the same whitelist as core) and is
 * applied by writing those properties inline, since it has no `[data-surface]`
 * stylesheet block.
 */
import type { AppearanceSettings } from '@praxis/core';
import {
  findSurfacePattern, SURFACE_MOTIF_ANIMATIONS,
  type SurfaceMotifAnimation, type SurfacePatternSpec
} from './surfacePatterns';

export type SurfaceMode = 'light' | 'dark';

export interface SurfacePackDefinition {
  id: string;
  name: string;
  description: string;
  /** Which appearance modes the pack is designed for. Noir is dark-only. */
  supports: SurfaceMode[];
  /** True once the pack uses the translucency / backdrop-blur path. */
  glass: boolean;
  /** Rollout phase the pack first ships in. */
  phase: 1 | 2 | 3;
  source: 'built-in' | 'custom' | 'marketplace';
  /** A built-in pack to inherit `data-surface` styling from (custom packs only). */
  basePackId?: string;
  /**
   * `--surface-*` overrides applied inline while this pack is active (custom
   * packs only). Built-in packs express everything through their stylesheet
   * block and leave this undefined.
   */
  tokens?: Record<string, string>;
  /**
   * The pack's watermark pattern, selected from the shared pattern library by
   * id (see `surfacePatterns.ts`). Declaring it as data is what keeps a new
   * material from needing new CSS — `applySurfacePack` renders it to the
   * `--surface-watermark-*` properties that every pane and the splash read.
   */
  pattern?: SurfacePatternSpec;
  /**
   * Parameters for the Settings gallery swatch. The card renders these *over*
   * the live theme tokens so the preview is the real pack × theme combination.
   * `canvas` / `panel` are CSS `background` shorthands layered on the preview's
   * theme-coloured base; `blend` is the swatch `mix-blend-mode`.
   */
  swatch: { canvas?: string; panel?: string; blend?: string };
}

/**
 * The only custom-property keys a custom pack may set — mirrors
 * `SURFACE_TOKEN_KEYS` in `packages/core/src/config/appSettings.ts`. Keep the
 * two in sync; core is the validation authority, this copy drives the editor
 * and the inline-apply path.
 */
export const SURFACE_TOKEN_KEYS: readonly string[] = [
  '--surface-app-bg-image', '--surface-app-bg-size', '--surface-app-bg-blend',
  '--surface-texture-image', '--surface-texture-size', '--surface-texture-opacity', '--surface-texture-blend',
  '--surface-panel-border-color', '--surface-radius-boost', '--surface-accent-glow',
  '--surface-panel-opacity', '--surface-panel-blur', '--surface-panel-saturate'
];

const BUILT_IN: SurfacePackDefinition[] = [
  {
    id: 'flat',
    name: 'Flat',
    description: 'No material layer. The app looks exactly as the theme alone renders it.',
    supports: ['light', 'dark'],
    glass: false,
    phase: 1,
    source: 'built-in',
    swatch: {}
  },
  {
    id: 'parchment',
    name: 'Parchment',
    description: 'Paper-fibre grain, a warm wash, and a faint hexagon watermark across every pane. The default Praxis look.',
    supports: ['light', 'dark'],
    glass: false,
    phase: 1,
    source: 'built-in',
    // Smaller cells, a few solid, anchored as a fading corner motif rather than
    // wallpaper — the Praxis brand mark rather than a material.
    pattern: {
      id: 'hexagon', scale: 62, opacity: 0.3, ink: 'accent',
      placement: 'corner', anchor: 'top-right', spread: 760, fade: 0.62, fill: 0.34
    },
    swatch: {
      canvas: 'radial-gradient(130% 90% at 15% 0%, var(--accent-soft), transparent 55%)',
      panel: 'var(--surface-swatch-fibre)',
      blend: 'soft-light'
    }
  },
  {
    id: 'graphite',
    name: 'Graphite',
    description: 'Brushed-metal micro-texture, a crisp top bevel, deeper shadows, and a fine diagonal pattern. Precision-instrument feel.',
    supports: ['light', 'dark'],
    glass: false,
    phase: 1,
    source: 'built-in',
    pattern: { id: 'diagonal', scale: 92, opacity: 0.17, ink: 'text' },
    swatch: {
      panel: 'linear-gradient(180deg, rgba(255,255,255,.14), transparent 32%), var(--surface-swatch-brushed)',
      blend: 'overlay'
    }
  },
  {
    id: 'aurora-glass',
    name: 'Aurora Glass',
    description: 'Frosted translucent panels, a slow ambient gradient on the canvas, and an accent glow on focus. Uses native window blur where the OS supports it.',
    supports: ['light', 'dark'],
    glass: true,
    phase: 2,
    source: 'built-in',
    pattern: { id: 'none', scale: 40, opacity: 0, ink: 'text' },
    swatch: {
      canvas:
        'linear-gradient(120deg, var(--accent-soft), transparent 45%), ' +
        'radial-gradient(80% 60% at 85% 15%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 70%)',
      panel: 'linear-gradient(150deg, rgba(255,255,255,.16), rgba(255,255,255,.03) 60%)',
      blend: 'screen'
    }
  },
  {
    id: 'noir',
    name: 'Noir',
    description: 'Heavy film grain, a high-contrast vignette, and flattened shadows. Dark themes only.',
    supports: ['dark'],
    glass: false,
    phase: 2,
    source: 'built-in',
    // No watermark: Noir's character is the heavy grain and the hard vignette,
    // and a figurative lattice fights both. The library still offers `weave`
    // to any pack that wants it.
    pattern: { id: 'none', scale: 40, opacity: 0 },
    swatch: {
      canvas: 'radial-gradient(120% 90% at 50% 0%, transparent 35%, rgba(0,0,0,.6))',
      panel: 'var(--surface-swatch-grain)',
      blend: 'overlay'
    }
  }
];

export const SURFACE_PACKS: SurfacePackDefinition[] = BUILT_IN;
export const BUILT_IN_SURFACE_PACK_IDS: string[] = BUILT_IN.map(pack => pack.id);
export const DEFAULT_SURFACE_PACK_ID = 'parchment';

let customPacks: SurfacePackDefinition[] = [];

/** Coerces a persisted pattern record into a spec, dropping unknown pattern ids. */
function readPatternSpec(value: unknown): SurfacePatternSpec | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !findSurfacePattern(raw.id)) return undefined;
  const num = (input: unknown, fallback: number) =>
    typeof input === 'number' && Number.isFinite(input) ? input : fallback;
  return {
    id: raw.id,
    scale: Math.min(400, Math.max(8, num(raw.scale, 100))),
    opacity: Math.min(1, Math.max(0, num(raw.opacity, 0.1))),
    ink: raw.ink === 'text' ? 'text' : raw.ink === 'custom' ? 'custom' : 'accent',
    inkColor: typeof raw.inkColor === 'string' ? raw.inkColor : undefined,
    placement: raw.placement === 'corner' ? 'corner' : 'tile',
    anchor: typeof raw.anchor === 'string' ? raw.anchor as SurfacePatternSpec['anchor'] : undefined,
    anchors: Array.isArray(raw.anchors)
      ? (raw.anchors.filter((item): item is string => typeof item === 'string') as SurfacePatternSpec['anchors'])
      : undefined,
    spread: Math.min(2400, Math.max(120, num(raw.spread, 720))),
    fade: Math.min(1, Math.max(0.05, num(raw.fade, 0.62))),
    fill: Math.min(1, Math.max(0, num(raw.fill, 0))),
    outline: Math.min(1, Math.max(0, num(raw.outline, 0))),
    outlineInk: typeof raw.outlineInk === 'string' ? raw.outlineInk : undefined,
    weight: Math.min(1, Math.max(0.005, num(raw.weight, 0.055))),
    blend: typeof raw.blend === 'string' ? raw.blend : undefined,
    // The style selects a keyframe block by name, so — like core's validator —
    // it is matched against the known set rather than passed through.
    animation: SURFACE_MOTIF_ANIMATIONS.some(entry => entry.id === raw.animation)
      ? raw.animation as SurfaceMotifAnimation
      : undefined,
    animationSpeed: Math.min(4, Math.max(0.25, num(raw.animationSpeed, 1))),
    animationRepeat: raw.animationRepeat === true
  };
}

/** Coerces persisted pack records into resolved definitions (token whitelist, base-pack inheritance, pattern spec). */
function coercePacks(
  records: AppearanceSettings['customSurfacePacks'],
  source: 'custom' | 'marketplace'
): SurfacePackDefinition[] {
  return (records ?? []).map(record => {
    const base = record.basePackId ? BUILT_IN.find(pack => pack.id === record.basePackId) : undefined;
    const tokens = Object.fromEntries(
      Object.entries(record.tokens ?? {}).filter(([key]) => SURFACE_TOKEN_KEYS.includes(key))
    );
    // A custom pack's own pattern wins; otherwise it inherits its base pack's.
    const pattern = readPatternSpec((record as { pattern?: unknown }).pattern) ?? base?.pattern;
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      supports: ['light', 'dark'] as SurfaceMode[],
      glass: (base?.glass ?? false)
        || tokens['--surface-panel-opacity'] !== undefined
        || tokens['--surface-panel-blur'] !== undefined,
      phase: 2 as const,
      source,
      basePackId: record.basePackId,
      tokens,
      pattern,
      swatch: base?.swatch ?? {}
    };
  });
}

// Packs installed from the add-on marketplace — a bucket of their own so the
// Surfaces editor's `registerCustomSurfacePacks` (user drafts only) and this
// never overwrite each other.
let installedAddonPacks: SurfacePackDefinition[] = [];

/** Registers the profile's user-created packs so `findSurfacePack` resolves them. */
export function registerCustomSurfacePacks(records: AppearanceSettings['customSurfacePacks']): void {
  customPacks = coercePacks(records, 'custom');
}

export function registerMarketplaceSurfacePacks(records: AppearanceSettings['customSurfacePacks']): void {
  installedAddonPacks = coercePacks(records, 'marketplace');
}

export function allSurfacePacks(): SurfacePackDefinition[] {
  return [...SURFACE_PACKS, ...customPacks, ...installedAddonPacks];
}

export function findSurfacePack(id: string): SurfacePackDefinition | undefined {
  return allSurfacePacks().find(pack => pack.id === id);
}
