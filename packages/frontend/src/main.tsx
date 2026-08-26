import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyThemePreference, getInitialThemeId } from './themes';
import './theme.css';

document.documentElement.setAttribute('data-accent', localStorage.getItem('tm-theme-accent') ?? 'violet');
applyThemePreference(getInitialThemeId(), localStorage.getItem('tm-theme-mode') === 'light' ? 'light' : 'dark');
void window.ticketManager.settings.get().then(settings => {
  applyThemePreference(settings.appearance.themeId, settings.appearance.themeMode);
}).catch(() => {
  // Local storage remains a usable first-launch fallback when settings are unavailable.
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
