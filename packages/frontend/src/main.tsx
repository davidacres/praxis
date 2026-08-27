import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import {
  applySurfacePack,
  applyThemePreference,
  getInitialSurfaceId,
  getInitialSurfaceOpts,
  getInitialThemeId,
  registerCustomThemes
} from './themes';
import { registerCustomSurfacePacks } from './surfacePacks';
import './theme.css';
import './surfaces.css';

document.documentElement.setAttribute('data-accent', localStorage.getItem('tm-theme-accent') ?? 'violet');
applyThemePreference(getInitialThemeId(), localStorage.getItem('tm-theme-mode') === 'light' ? 'light' : 'dark');
applySurfacePack(getInitialSurfaceId(), getInitialSurfaceOpts());
void window.ticketManager.settings.get().then(settings => {
  registerCustomThemes(settings.appearance.customThemes);
  applyThemePreference(settings.appearance.themeId, settings.appearance.themeMode);
  registerCustomSurfacePacks(settings.appearance.customSurfacePacks);
  applySurfacePack(settings.appearance.surfacePackId, {
    intensity: settings.appearance.surface.intensity,
    texture: settings.appearance.surface.texture,
    translucency: settings.appearance.surface.translucency
  });
}).catch(() => {
  // Local storage remains a usable first-launch fallback when settings are unavailable.
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
