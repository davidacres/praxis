import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import {
  applySurfacePack,
  applyThemePreference,
  getInitialSurfaceId,
  getInitialSurfaceOpts,
  getInitialThemeId,
  refreshSurfacePattern,
  registerCustomThemes
} from './settings/themes';
import { registerCustomSurfacePacks } from './settings/surfacePacks';
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

void window.praxis.settings.get().then(settings => {
  registerCustomThemes(settings.appearance.customThemes);
  applyThemePreference(settings.appearance.themeId, settings.appearance.themeMode);
  registerCustomSurfacePacks(settings.appearance.customSurfacePacks);
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
