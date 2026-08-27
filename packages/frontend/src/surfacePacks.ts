/**
 * Surface packs — the premium *material* layer that composes over the colour
 * theme. A pack sets only `--surface-*` custom properties (texture, panel
 * material, translucency, glow); it never defines a colour token, so any pack
 * works over any theme. See `surfaces.css` for the `[data-surface]` blocks and
 * `applySurfacePack` in `themes.ts` for how a pack + the user dials are applied.
 *
 * Phase 1 ships four opaque packs. Translucency (Aurora Glass, Noir) and native
 * window vibrancy arrive in later phases; the token layer is already shaped for
 * them.
 */
import type { AppearanceSettings } from '@ticket-manager/core';

export type SurfaceMode = 'light' | 'dark';

export interface SurfacePackDefinition {
  id: string;
  name: string;
  description: string;
  /** Which appearance modes the pack is designed for. */
  supports: SurfaceMode[];
  /** True once the pack uses the translucency / backdrop-blur path. */
  glass: boolean;
  /** Rollout phase the pack first ships in. */
  phase: 1 | 2 | 3;
  source: 'built-in' | 'custom';
  /**
   * Parameters for the Settings gallery swatch. The card renders these *over*
   * the live theme tokens so the preview is the real pack × theme combination.
   * `canvas` / `panel` are CSS `background` shorthands layered on the preview's
   * theme-coloured base; `blend` is the swatch `mix-blend-mode`.
   */
  swatch: { canvas?: string; panel?: string; blend?: string };
}

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
    description: 'Paper-fibre grain on panels and a warm vignette on the canvas. The default Praxis look.',
    supports: ['light', 'dark'],
    glass: false,
    phase: 1,
    source: 'built-in',
    swatch: {
      canvas: 'radial-gradient(130% 90% at 15% 0%, var(--accent-soft), transparent 55%)',
      panel: 'var(--surface-swatch-fibre)',
      blend: 'soft-light'
    }
  },
  {
    id: 'graphite',
    name: 'Graphite',
    description: 'Brushed-metal micro-texture, a crisp top bevel, and deeper shadows. Precision-instrument feel.',
    supports: ['light', 'dark'],
    glass: false,
    phase: 1,
    source: 'built-in',
    swatch: {
      panel: 'linear-gradient(180deg, rgba(255,255,255,.14), transparent 32%), var(--surface-swatch-brushed)',
      blend: 'overlay'
    }
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    description: 'A faint drafting grid on the canvas; panels stay clean. Reads as an engineering workspace.',
    supports: ['light', 'dark'],
    glass: false,
    phase: 1,
    source: 'built-in',
    swatch: {
      canvas:
        'linear-gradient(var(--accent-soft) 1px, transparent 1px) 0 0 / 100% 12px, ' +
        'linear-gradient(90deg, var(--accent-soft) 1px, transparent 1px) 0 0 / 12px 100%'
    }
  }
];

export const SURFACE_PACKS: SurfacePackDefinition[] = BUILT_IN;
export const BUILT_IN_SURFACE_PACK_IDS: string[] = BUILT_IN.map(pack => pack.id);
export const DEFAULT_SURFACE_PACK_ID = 'parchment';

let customPacks: SurfacePackDefinition[] = [];

/** Registers the profile's user-created packs so `findSurfacePack` resolves them. Phase 1 has no editor yet. */
export function registerCustomSurfacePacks(records: AppearanceSettings['customSurfacePacks']): void {
  customPacks = (records ?? []).map(record => ({
    id: record.id,
    name: record.name,
    description: record.description,
    supports: ['light', 'dark'] as SurfaceMode[],
    glass: false,
    phase: 1 as const,
    source: 'custom' as const,
    swatch: {}
  }));
}

export function allSurfacePacks(): SurfacePackDefinition[] {
  return [...SURFACE_PACKS, ...customPacks];
}

export function findSurfacePack(id: string): SurfacePackDefinition | undefined {
  return allSurfacePacks().find(pack => pack.id === id);
}
