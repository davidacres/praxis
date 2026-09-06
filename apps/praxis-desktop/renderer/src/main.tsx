import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { DialogHost } from './ui/dialogs';
import {
  applySurfacePack,
  applyThemePreference,
  getInitialSurfaceId,
  getInitialSurfaceOpts,
  getInitialThemeId,
  refreshSurfacePattern,
  registerCustomThemes,
  registerMarketplaceThemes
} from './settings/themes';
import { registerCustomSurfacePacks, registerMarketplaceSurfacePacks } from './settings/surfacePacks';
import type { AppSettings } from '@praxis/core';
import './theme.css';
import './surfaces.css';

document.documentElement.setAttribute('data-accent', localStorage.getItem('tm-theme-accent') ?? 'violet');
applyThemePreference(getInitialThemeId(), localStorage.getItem('tm-theme-mode') === 'light' ? 'light' : 'dark');
applySurfacePack(getInitialSurfaceId(), getInitialSurfaceOpts());

// A pattern's colour is baked into its SVG data URI, so it cannot follow a
// `var()`. Re-bake it whenever the palette changes to keep the watermark tinted
// from the live theme.
window.addEventListener('tm-theme-changed', () => refreshSurfacePattern());

// Motif motion is baked in or left out at paint time, not toggled in CSS — a
// reduced-motion query inside an SVG-as-image is ignored by the renderer, so
// the preference can only be honoured by re-baking when it changes.
window.matchMedia('(prefers-reduced-motion: reduce)')
  .addEventListener('change', () => refreshSurfacePattern());

// The Aurora Glass ambient layer pauses its animation while the window is not
// focused (see surfaces.css). Renderer-only — no IPC needed for window blur.
const setWindowActive = (active: boolean) =>
  document.documentElement.setAttribute('data-window-active', String(active));
setWindowActive(document.hasFocus());
window.addEventListener('focus', () => setWindowActive(true));
window.addEventListener('blur', () => setWindowActive(false));

// Themes/packs installed from the add-on marketplace live in their own bucket
// (see registerMarketplace* in settings/themes + surfacePacks), separate from
// the user's own custom entries in the settings document, and are re-fetched
// whenever an add-on is installed, removed, or toggled.
async function applyMarketplaceAppearance(): Promise<void> {
  try {
    const active = await window.praxis.marketplace.listActiveAppearance();
    registerMarketplaceThemes(
      active.themes.map(theme => ({
        id: theme.id,
        name: theme.name,
        mode: theme.mode,
        description: theme.description,
        preview: theme.preview
      }))
    );
    registerMarketplaceSurfacePacks(
      active.surfacePacks.map(pack => ({
        id: pack.id,
        name: pack.name,
        description: pack.description,
        basePackId: pack.basePackId,
        tokens: pack.tokens,
        pattern: pack.pattern as AppSettings['appearance']['customSurfacePacks'][number]['pattern']
      }))
    );
  } catch {
    // No marketplace configured or it is unreachable — the user's own custom
    // themes/packs still apply.
  }
}

void window.praxis.settings.get().then(async settings => {
  registerCustomThemes(settings.appearance.customThemes);
  registerCustomSurfacePacks(settings.appearance.customSurfacePacks);
  await applyMarketplaceAppearance();
  applyThemePreference(settings.appearance.themeId, settings.appearance.themeMode);
  applySurfacePack(settings.appearance.surfacePackId, {
    intensity: settings.appearance.surface.intensity,
    texture: settings.appearance.surface.texture,
    translucency: settings.appearance.surface.translucency,
    windowVibrancy: settings.appearance.surface.windowVibrancy,
    animateMotifs: settings.appearance.surface.animateMotifs,
    motif: settings.appearance.surface.motif
  });
}).catch(() => {
  // Local storage remains a usable first-launch fallback when settings are unavailable.
});

window.praxis.marketplace.onChanged(() => {
  void applyMarketplaceAppearance().then(() => {
    // Nudge any open Themes/Surfaces gallery to re-read the pack/theme lists.
    window.dispatchEvent(new Event('tm-theme-changed'));
  });
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DialogHost>
      <App />
    </DialogHost>
  </StrictMode>
);
